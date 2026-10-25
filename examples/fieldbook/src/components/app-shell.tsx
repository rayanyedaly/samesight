"use client";

import { useQuery } from "@powersync/react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { type SignOutResult, useSession, useSignedIn } from "./session-provider";
import { SignIn } from "./sign-in";
import { SyncStatus } from "./sync-status";

/** Renders children for a signed-in user with a tenant, or the right fallback. */
export function AppShell({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state.status === "loading") {
    return (
      <p role="status" className="p-8 text-sm text-muted">
        Loading…
      </p>
    );
  }
  if (state.status === "signed-out") return <SignIn />;
  return <SignedInShell>{children}</SignedInShell>;
}

function SignedInShell({ children }: { children: ReactNode }) {
  const { claims } = useSignedIn();
  const { data: tenants } = useQuery<{ name: string }>("SELECT name FROM Tenant LIMIT 1");

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-4">
        <Link href="/" className="text-lg font-semibold">
          Fieldbook
        </Link>
        <span className="text-sm text-muted">{tenants[0]?.name ?? ""}</span>
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <SyncStatus />
          <span className="min-w-0 truncate text-sm">
            {claims.email}
            {claims.appRole && <span className="ml-1 text-xs text-muted">({claims.appRole.toLowerCase()})</span>}
          </span>
          <SignOutButton />
        </span>
      </header>
      {claims.tenantId ? (
        <main className="pt-6">{children}</main>
      ) : (
        <p className="pt-6 text-sm">This account has no membership in any team, so there is nothing to show.</p>
      )}
    </div>
  );
}

function SignOutButton() {
  const { signOut } = useSession();
  const [result, setResult] = useState<SignOutResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(force: boolean) {
    setBusy(true);
    try {
      setResult(await signOut({ force }));
    } finally {
      setBusy(false);
    }
  }

  if (result?.status === "pending") {
    return (
      <span role="alert" className="flex basis-full flex-wrap items-center justify-end gap-2 text-sm">
        <span className="text-danger">
          {result.count} unsynced change{result.count === 1 ? "" : "s"} will be lost.
        </span>
        <button type="button" className="btn-danger" disabled={busy} onClick={() => void run(true)}>
          Sign out anyway
        </button>
        {/* biome-ignore lint/a11y/noAutofocus: focus moves into the confirmation that replaced the button */}
        <button type="button" className="btn" autoFocus onClick={() => setResult(null)}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <>
      <button type="button" className="btn" disabled={busy} onClick={() => void run(false)}>
        Sign out
      </button>
      {result?.status === "error" && (
        <span role="alert" className="basis-full text-right text-sm text-danger">
          Could not sign out: {result.message}
        </span>
      )}
    </>
  );
}
