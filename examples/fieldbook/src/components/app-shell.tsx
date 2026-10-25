"use client";

import { useQuery } from "@powersync/react";
import { ConfirmDialog, RejectedWritesBanner, type SignOutResult, SyncStatusChip } from "@samesight/next";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useSession, useSignedIn } from "./session-provider";
import { SignIn } from "./sign-in";

/**
 * Renders children for a signed-in user with an open store, or the right fallback. The
 * provider itself shows the unlock and recovery screens.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { state } = useSession();
  if (state.status === "signed-out") return <SignIn />;
  if (state.status !== "ready") {
    return (
      <p role="status" className="p-8 text-sm text-muted">
        Loading…
      </p>
    );
  }
  return <SignedInShell>{children}</SignedInShell>;
}

function SignedInShell({ children }: { children: ReactNode }) {
  const { claims } = useSignedIn();
  const { data: tenants } = useQuery<{ name: string }>("SELECT name FROM Tenant LIMIT 1");

  return (
    <>
      <RejectedWritesBanner />
      <div className="mx-auto max-w-3xl px-4 pb-16">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-4">
          <Link href="/" className="text-lg font-semibold">
            Fieldbook
          </Link>
          <span className="text-sm text-muted">{tenants[0]?.name ?? ""}</span>
          <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <SyncStatusChip />
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
    </>
  );
}

function lossText(count: number | null): string {
  if (count === null) return "The changes queued on this device could not be counted, and any that have not synced will be lost.";
  return `${count} change${count === 1 ? "" : "s"} made on this device ${count === 1 ? "has" : "have"} not synced and will be lost for good.`;
}

function SignOutButton() {
  const { signOut } = useSession();
  const [result, setResult] = useState<SignOutResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(force: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      setResult(await signOut({ force }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Not disabled while counting: the confirmation returns focus here on cancel. */}
      <button type="button" className="btn" aria-disabled={busy} onClick={() => void run(false)}>
        Sign out
      </button>
      {result?.status === "error" && (
        <span role="alert" className="basis-full text-right text-sm text-danger">
          Could not sign out: {result.message}
        </span>
      )}
      <ConfirmDialog
        open={result?.status === "pending"}
        title="Sign out and discard unsynced changes?"
        body={result?.status === "pending" ? lossText(result.count) : ""}
        confirmLabel="Discard and sign out"
        busyLabel="Signing out…"
        cancelLabel="Stay signed in"
        destructive
        busy={busy}
        onConfirm={() => void run(true)}
        onCancel={() => setResult(null)}
      />
    </>
  );
}
