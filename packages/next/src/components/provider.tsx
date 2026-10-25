"use client";

import { PowerSyncContext } from "@powersync/react";
import type { PowerSyncDatabase } from "@powersync/web";
import { type StuckUpload, SupabaseConnector } from "@samesight/supabase";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_IDLE_MS, IdleLock } from "../session/idle-lock";
import { endSession, lockStore, signOutAndWipe, signOutKeeping, unsyncedCount } from "../session/session-client";
import { storedSession } from "../session/stored-session";
import type { EncryptedStore } from "../store/db";
import { getSessionUserId, hasSessionKey } from "../store/session-key";
import { deriveAndHoldKey, tryUnlock, type UnlockResult } from "../store/unlock";
import { RecoverScreen, type RecoverScreenCopy } from "./recover-screen";
import { type LockReason, UnlockScreen, type UnlockScreenCopy } from "./unlock-screen";

/**
 * What the app renders against:
 *  - loading:    the session or the store is still being read.
 *  - signed-out: no session on this device. The app shows its sign-in form.
 *  - locked:     a session and an encrypted store, but no key in memory (a reload, the
 *                idle lock, or a password changed elsewhere). The provider shows the
 *                unlock screen, which works offline.
 *  - recover:    the store will not open with the right key (schema change,
 *                corruption). The provider shows the recovery screen.
 *  - ready:      the store is open; the children get the PowerSync context.
 */
export type SamesightState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "locked"; userId: string; email: string | null; reason: LockReason }
  | { status: "recover"; userId: string }
  | { status: "ready"; session: Session; db: PowerSyncDatabase };

export type SignOutResult =
  | { status: "done" }
  /** Writes are still queued (count null: the queue could not be read). Ask, then pass `force`. */
  | { status: "pending"; count: number | null }
  | { status: "error"; message: string };

export interface SamesightContextValue {
  state: SamesightState;
  /** The last upload held in the queue instead of retried or rejected (413, missing RPC). */
  stuck: StuckUpload | null;
  /** Sign in with Supabase and derive the store key from the same password. Returns an error message or null. */
  signIn: (email: string, password: string) => Promise<string | null>;
  /** Reopen the store after a reload or the idle lock. Works offline. */
  unlock: (password: string) => Promise<UnlockResult>;
  /** Forget the key and close the store, keeping it and the session. */
  lock: () => Promise<void>;
  /**
   * Sign out. With the store open: stops with `pending` while writes are queued, unless
   * `force`; otherwise discards the store, which is safe because everything synced.
   * With the store locked, it can't count the queue, so it signs out and keeps the store.
   */
  signOut: (options?: { force?: boolean }) => Promise<SignOutResult>;
  /** After the recovery screen: open the store again, asking for the password if the key was dropped. */
  retry: () => Promise<void>;
  /** Discard this user's store on this device and start again from the server. Destructive. */
  discardLocalData: () => Promise<void>;
}

const SamesightContext = createContext<SamesightContextValue | null>(null);

export function useSamesight(): SamesightContextValue {
  const value = useContext(SamesightContext);
  if (!value) throw new Error("useSamesight must be used inside <SamesightProvider>");
  return value;
}

export interface SamesightProviderProps {
  supabase: SupabaseClient;
  /** The `storageKey` the Supabase client was created with. */
  authStorageKey: string;
  /** From `createEncryptedStore`, created once at module level. */
  store: EncryptedStore;
  /** PowerSync service URL. Without it the store works locally and never syncs. */
  powersyncUrl?: string;
  /**
   * What the sync stream depends on in the token, e.g. tenant and role. When it changes
   * (a membership change), the provider reconnects so the device stops holding data
   * from the old scope.
   */
  syncScope?: (session: Session) => string;
  /** Idle time before the store locks; null turns the idle lock off. */
  idleLockMs?: number | null;
  copy?: { unlock?: Partial<UnlockScreenCopy>; recover?: Partial<RecoverScreenCopy> };
  children: ReactNode;
}

type Phase =
  | { kind: "boot" }
  | { kind: "locked"; userId: string; reason: LockReason }
  | { kind: "recover"; userId: string }
  | { kind: "ready"; userId: string; db: PowerSyncDatabase };

export function SamesightProvider({
  supabase,
  authStorageKey,
  store,
  powersyncUrl,
  syncScope,
  idleLockMs = DEFAULT_IDLE_MS,
  copy,
  children,
}: SamesightProviderProps) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "boot" });
  const [stuck, setStuck] = useState<StuckUpload | null>(null);
  // While signIn() is deriving the key, the session already exists; the boot decision
  // must wait for the key instead of concluding "locked".
  const signingIn = useRef(false);
  const target = useMemo(() => ({ supabase, authStorageKey }), [supabase, authStorageKey]);

  useEffect(() => {
    const auth = supabase.auth;
    // Offline with an expired token there is no refreshed session, but nobody signed
    // out: fall back to the stored one. Start from it too, since getSession() retries a
    // failing refresh for several seconds.
    const cached = storedSession(authStorageKey);
    setSession(cached);
    void auth.getSession().then(({ data }) => setSession(data.session ?? storedSession(authStorageKey)));
    const { data } = auth.onAuthStateChange((event, next) =>
      setSession(next ?? (event === "SIGNED_OUT" ? null : storedSession(authStorageKey))),
    );
    // Back online: getSession() refreshes an expired token and emits TOKEN_REFRESHED.
    const refresh = () => void auth.getSession();
    window.addEventListener("online", refresh);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("online", refresh);
    };
  }, [supabase, authStorageKey]);

  const boot = useCallback(
    async (userId: string) => {
      const db = await store.open();
      if (!db) {
        setPhase({ kind: "locked", userId, reason: "reload" });
        return;
      }
      const probe = await store.probe();
      if (probe === "ok") {
        setPhase({ kind: "ready", userId, db });
      } else if (probe === "wrong-key") {
        // Only reachable from sign-in: the store was encrypted under an earlier password.
        // Keep the new key held, so discarding can open a fresh store without asking again.
        await store.close();
        setPhase({ kind: "locked", userId, reason: "password-changed" });
      } else {
        // Never deleted automatically: it may hold writes that never reached the server.
        setPhase({ kind: "recover", userId });
      }
    },
    [store],
  );

  const sessionLoaded = session !== undefined;
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!sessionLoaded || signingIn.current) return;
    // A held upload belongs to the user it was reported for.
    setStuck(null);
    let cancelled = false;
    void (async () => {
      if (!userId) {
        // Signed out here, in another tab, or the refresh token was refused: lock, never wipe.
        await store.lock();
        if (!cancelled) setPhase({ kind: "boot" });
        return;
      }
      if (getSessionUserId() === userId) {
        await boot(userId);
        return;
      }
      // A key held for another user is never used for this one.
      if (hasSessionKey()) await store.lock();
      if (cancelled) return;
      if (store.exists(userId)) {
        setPhase({ kind: "locked", userId, reason: "reload" });
      } else {
        // A session but no store: the key can only come from the password, which only a
        // sign-in provides. Nothing local is lost.
        await endSession(target);
        if (!cancelled) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionLoaded, userId, store, boot, target]);

  const connector = useMemo(
    () =>
      powersyncUrl
        ? new SupabaseConnector({
            supabase,
            powersyncUrl,
            isSignedIn: () => storedSession(authStorageKey) !== null,
            // The store opens with the held key's user, so that user owns it.
            ownerId: getSessionUserId,
            onStuck: (info) => {
              console.warn("[samesight] upload held in the queue", info);
              setStuck(info);
            },
            onUploaded: () => setStuck(null),
          })
        : null,
    [supabase, powersyncUrl, authStorageKey],
  );

  const scope = session && syncScope ? syncScope(session) : "";
  const connected = useRef<{ db: PowerSyncDatabase; scope: string } | null>(null);
  useEffect(() => {
    if (phase.kind !== "ready" || !connector) return;
    const { db } = phase;
    if (connected.current?.db === db && connected.current.scope === scope) return;
    connected.current = { db, scope };
    db.connect(connector).catch((e: unknown) => console.warn("[samesight] connect failed", e));
  }, [phase, scope, connector]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      signingIn.current = true;
      let signedIn = false;
      try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error || !data.session) return error?.message ?? "Sign-in failed";
        signedIn = true;
        const id = data.session.user.id;
        if (hasSessionKey() && getSessionUserId() !== id) await store.lock();
        await deriveAndHoldKey(store, id, password);
        setSession(data.session);
        await boot(id);
        return null;
      } catch (e) {
        // The key could not be derived or held (no WebCrypto off a secure origin, storage
        // full): end the new session, so the form comes back with the error instead of
        // the boot decision waiting for a key that will not come.
        if (signedIn) {
          await endSession(target);
          setSession(null);
        }
        return e instanceof Error ? e.message : String(e);
      } finally {
        signingIn.current = false;
      }
    },
    [supabase, store, boot, target],
  );

  const unlock = useCallback(
    async (password: string): Promise<UnlockResult> => {
      if (!userId) return "wrong";
      const result = await tryUnlock(store, userId, password);
      // Signed out (here or in another tab) while the key was being derived: do not leave
      // the store open and keyed behind a signed-out screen.
      if (storedSession(authStorageKey)?.user.id !== userId) {
        await store.lock();
        return "wrong";
      }
      const db = store.current();
      if (result === "ok" && db) setPhase({ kind: "ready", userId, db });
      else if (result === "recover") setPhase({ kind: "recover", userId });
      return result;
    },
    [store, userId, authStorageKey],
  );

  const lock = useCallback(async () => {
    connected.current = null;
    // Leave "ready" first: while the store closes, the app shell (and its sign-out) must
    // not run against a store that is going away.
    if (userId) setPhase({ kind: "locked", userId, reason: "idle" });
    setStuck(null);
    await lockStore(store);
  }, [store, userId]);

  const signOut = useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<SignOutResult> => {
      try {
        if (phase.kind !== "ready") {
          // The store is locked or will not open, so its queue cannot be counted. Leaving
          // is not a reason to destroy it: the same user's password reopens it.
          await signOutKeeping(store, target);
        } else {
          // Counted here, not from a rendered count, so a write queued a moment ago or a
          // count that has not loaded yet cannot be discarded without asking.
          const count = await unsyncedCount(store);
          if ((count === null || count > 0) && !force) return { status: "pending", count };
          connected.current = null;
          await signOutAndWipe(store, target, phase.userId);
        }
        setPhase({ kind: "boot" });
        setSession(null);
        setStuck(null);
        return { status: "done" };
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    },
    [phase, store, target],
  );

  const retry = useCallback(async () => {
    if (!userId) return;
    await store.close();
    if (getSessionUserId() === userId) await boot(userId);
    else setPhase({ kind: "locked", userId, reason: "reload" });
  }, [store, userId, boot]);

  const discardLocalData = useCallback(async () => {
    if (!userId) return;
    connected.current = null;
    await store.wipe(userId);
    if (getSessionUserId() === userId) await boot(userId);
    else setPhase({ kind: "locked", userId, reason: "reload" });
  }, [store, userId, boot]);

  // For the lock and recover screens, which show a failure rather than a result.
  const signOutOrThrow = useCallback(async () => {
    const result = await signOut();
    if (result.status === "error") throw new Error(result.message);
  }, [signOut]);

  const state: SamesightState = useMemo(() => {
    if (session === undefined) return { status: "loading" };
    if (session === null) return { status: "signed-out" };
    const id = session.user.id;
    // A phase left over from another user is never shown for this one.
    if (phase.kind === "boot" || phase.userId !== id) return { status: "loading" };
    if (phase.kind === "locked")
      return { status: "locked", userId: id, email: session.user.email ?? null, reason: phase.reason };
    if (phase.kind === "recover") return { status: "recover", userId: id };
    return { status: "ready", session, db: phase.db };
  }, [session, phase]);

  const value = useMemo(
    () => ({ state, stuck, signIn, unlock, lock, signOut, retry, discardLocalData }),
    [state, stuck, signIn, unlock, lock, signOut, retry, discardLocalData],
  );

  let content: ReactNode = children;
  if (state.status === "locked") {
    content = (
      <UnlockScreen
        email={state.email}
        reason={state.reason}
        onUnlock={unlock}
        onSignOut={signOutOrThrow}
        onDiscard={discardLocalData}
        copy={copy?.unlock}
      />
    );
  } else if (state.status === "recover") {
    content = (
      <RecoverScreen
        onRetry={retry}
        onReset={discardLocalData} onSignOut={signOutOrThrow} copy={copy?.recover} />
    );
  } else if (state.status === "ready") {
    content = (
      <PowerSyncContext.Provider value={state.db}>
        {idleLockMs !== null && <IdleLock onLock={() => void lock()} idleMs={idleLockMs} />}
        {children}
      </PowerSyncContext.Provider>
    );
  }

  return <SamesightContext.Provider value={value}>{content}</SamesightContext.Provider>;
}
