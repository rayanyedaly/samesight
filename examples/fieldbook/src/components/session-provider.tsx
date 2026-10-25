"use client";

import { PowerSyncContext } from "@powersync/react";
import { PowerSyncDatabase } from "@powersync/web";
import type { Session } from "@supabase/supabase-js";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Claims, readClaims } from "@/lib/claims";
import { FieldbookConnector } from "@/lib/powersync/connector";
import { AppSchema } from "@/lib/powersync/schema";
import { clearStoredSession, storedSession, supabase } from "@/lib/supabase";

type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; claims: Claims; db: PowerSyncDatabase };

export type SignOutResult =
  | { status: "done" }
  | { status: "pending"; count: number }
  | { status: "error"; message: string };

type SessionContextValue = {
  state: SessionState;
  signIn: (email: string, password: string) => Promise<string | null>;
  /** Clears local data and signs out. Without force, stops if writes are still queued. */
  signOut: (options?: { force?: boolean }) => Promise<SignOutResult>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}

/** Claims and database for a signed-in user; only call below a signed-in gate. */
export function useSignedIn(): { claims: Claims; db: PowerSyncDatabase } {
  const { state } = useSession();
  if (state.status !== "signed-in") throw new Error("useSignedIn used while signed out");
  return state;
}

const SIGN_OUT_TIMEOUT_MS = 3000;

// One local database per user, so switching accounts in one browser never mixes data.
function openDatabase(userId: string): PowerSyncDatabase {
  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: `fieldbook-${userId}.db` },
  });
  void db.connect(new FieldbookConnector());
  return db;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [db, setDb] = useState<{ userId: string; db: PowerSyncDatabase } | null>(null);

  useEffect(() => {
    const auth = supabase().auth;
    // Offline with an expired token there is no refreshed session, but the user has not
    // signed out: fall back to the stored one so their local data stays usable. Start
    // from it too, since getSession() retries a failing refresh for several seconds.
    const cached = storedSession();
    if (cached) setSession(cached);
    void auth.getSession().then(({ data }) => setSession(data.session ?? storedSession()));
    const { data } = auth.onAuthStateChange((event, next) =>
      setSession(next ?? (event === "SIGNED_OUT" ? null : storedSession())),
    );
    // Back online: getSession() refreshes an expired token and emits TOKEN_REFRESHED.
    const refresh = () => void auth.getSession();
    window.addEventListener("online", refresh);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("online", refresh);
    };
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    const opened = openDatabase(userId);
    setDb({ userId, db: opened });
    return () => {
      void opened.close();
      setDb(null);
    };
  }, [userId]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  // A new token with a different tenant or role (membership changed) needs a new sync
  // stream, so the device stops holding data from the old scope.
  const claims = useMemo(() => (session ? readClaims(session.access_token) : null), [session]);
  const scope = claims ? `${claims.tenantId}:${claims.appRole}` : "";
  const connected = useRef<{ db: PowerSyncDatabase; scope: string } | null>(null);
  useEffect(() => {
    if (!db) return;
    if (connected.current?.db !== db.db) {
      connected.current = { db: db.db, scope };
    } else if (connected.current.scope !== scope) {
      connected.current.scope = scope;
      void db.db.connect(new FieldbookConnector());
    }
  }, [db, scope]);

  const signOut = useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<SignOutResult> => {
      try {
        if (db) {
          // Checked here, not from a rendered count, so a write queued a moment ago or a
          // count that has not loaded yet cannot be cleared without asking.
          const { count } = await db.db.getUploadQueueStats();
          if (count > 0 && !force) return { status: "pending", count };
          // Clears this user's local database, including writes that have not synced.
          await db.db.disconnectAndClear();
        }
        // Revokes the refresh token on the server. Offline it fails, and with an expired
        // token supabase-js first retries the refresh for many seconds and then returns
        // without removing anything (no SIGNED_OUT). So wait briefly, then forget the
        // session on this device ourselves.
        const result = await Promise.race([
          supabase().auth.signOut(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), SIGN_OUT_TIMEOUT_MS)),
        ]);
        if (!result || result.error || storedSession()) {
          clearStoredSession();
          setSession(null);
        }
        return { status: "done" };
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },
    [db],
  );

  const state: SessionState = useMemo(() => {
    if (session === undefined) return { status: "loading" };
    if (session === null) return { status: "signed-out" };
    if (!db || !claims || db.userId !== session.user.id) return { status: "loading" };
    return { status: "signed-in", claims, db: db.db };
  }, [session, claims, db]);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);

  return (
    <SessionContext.Provider value={value}>
      {state.status === "signed-in" ? (
        <PowerSyncContext.Provider value={state.db}>{children}</PowerSyncContext.Provider>
      ) : (
        children
      )}
    </SessionContext.Provider>
  );
}
