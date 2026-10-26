"use client";

import { useState } from "react";
import { ConfirmDialog } from "./confirm-dialog.tsx";

export interface RecoverScreenCopy {
  title: string;
  body: string;
  retry: string;
  reset: string;
  resetting: string;
  confirmTitle: string;
  confirmBody: string;
  confirmAction: string;
  cancel: string;
  signOut: string;
  /** After "Try again" when the data still does not open. */
  retryFailed: string;
  /** When resetting or signing out failed; nothing was changed. */
  actionFailed: string;
}

export const DEFAULT_RECOVER_COPY: RecoverScreenCopy = {
  title: "The data on this device can't be opened",
  body: "The local data could not be read. If you are offline, try again once you are back online. If it still fails (for example after an update), you can reset it and download everything again from the server.",
  retry: "Try again",
  reset: "Reset this device's data",
  resetting: "Resetting…",
  confirmTitle: "Reset the data on this device?",
  confirmBody:
    "Changes made on this device that have not synced will be lost for good. Everything else downloads again from the server.",
  confirmAction: "Reset",
  cancel: "Cancel",
  signOut: "Sign out (keeps the data on this device)",
  retryFailed: "It still can't be opened. If you are offline, try again once you are back online.",
  actionFailed: "That did not work. Check your connection and try again.",
};

/**
 * Shown when the store will not open for a reason other than a wrong key: a schema
 * change, corruption, or an asset the browser could not load (offline, before the
 * service worker cached it). Trying again comes first, because the last cause clears
 * up by itself. The store is never wiped automatically; resetting is an explicit,
 * secondary choice that names the loss. Signing out keeps the store.
 */
export function RecoverScreen({
  onRetry,
  onReset,
  onSignOut,
  copy: overrides,
}: {
  onRetry: () => Promise<void>;
  onReset: () => Promise<void>;
  onSignOut: () => Promise<void>;
  copy?: Partial<RecoverScreenCopy>;
}) {
  const copy = { ...DEFAULT_RECOVER_COPY, ...overrides };
  const [running, setRunning] = useState<"retry" | "reset" | "sign-out" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const busy = running !== null;

  async function run(kind: "retry" | "reset" | "sign-out", action: () => Promise<void>) {
    setRunning(kind);
    setMessage(null);
    try {
      await action();
      // Still here after a retry: it did not open. (On success this screen is gone.)
      if (kind === "retry") setMessage(copy.retryFailed);
    } catch {
      setMessage(copy.actionFailed);
    } finally {
      setRunning(null);
      setConfirming(false);
    }
  }

  return (
    <main className="ss-screen">
      <div className="ss-panel">
        <h1 className="ss-title">{copy.title}</h1>
        <p className="ss-text">{copy.body}</p>
        <div className="ss-form">
          <button
            type="button"
            className="ss-button ss-button-primary"
            onClick={() => void run("retry", onRetry)}
            disabled={busy}
            aria-busy={busy}
          >
            {copy.retry}
          </button>
          {message && (
            <p role="alert" className="ss-error">
              {message}
            </p>
          )}
        </div>
        <div className="ss-links">
          <button type="button" className="ss-link" onClick={() => setConfirming(true)} disabled={busy}>
            {copy.reset}
          </button>
          <button type="button" className="ss-link" onClick={() => void run("sign-out", onSignOut)} disabled={busy}>
            {copy.signOut}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title={copy.confirmTitle}
        body={copy.confirmBody}
        confirmLabel={copy.confirmAction}
        busyLabel={copy.resetting}
        cancelLabel={copy.cancel}
        destructive
        busy={busy}
        onConfirm={() => void run("reset", onReset)}
        onCancel={() => setConfirming(false)}
      />
    </main>
  );
}
