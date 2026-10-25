"use client";

import type { PowerSyncDatabase } from "@powersync/web";
import { SamesightProvider, useSamesight } from "@samesight/next";
import { type ReactNode, useMemo } from "react";
import { type Claims, readClaims } from "@/lib/claims";
import { env } from "@/lib/env";
import { store } from "@/lib/store";
import { AUTH_STORAGE_KEY, supabase } from "@/lib/supabase";

// The sync stream depends on the tenant and role claims; when they change (a
// membership change), the provider reconnects so the device drops the old scope.
const syncScope = (session: { access_token: string }) => {
  const claims = readClaims(session.access_token);
  return `${claims.tenantId}:${claims.appRole}`;
};

export function SessionProvider({ children }: { children: ReactNode }) {
  return (
    <SamesightProvider
      supabase={supabase()}
      authStorageKey={AUTH_STORAGE_KEY}
      store={store}
      powersyncUrl={env.powersyncUrl}
      syncScope={syncScope}
    >
      {children}
    </SamesightProvider>
  );
}

export const useSession = useSamesight;

/** Claims and database for a signed-in user with an open store; only call below that gate. */
export function useSignedIn(): { claims: Claims; db: PowerSyncDatabase } {
  const { state } = useSamesight();
  const token = state.status === "ready" ? state.session.access_token : null;
  const claims = useMemo(() => (token ? readClaims(token) : null), [token]);
  if (state.status !== "ready" || !claims) throw new Error("useSignedIn used without an open store");
  return { claims, db: state.db };
}
