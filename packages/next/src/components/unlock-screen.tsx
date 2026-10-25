"use client";

import { type FormEvent, useId, useState } from "react";
import type { UnlockResult } from "../store/unlock";
import { ConfirmDialog } from "./confirm-dialog";

/** Why the store is locked: a reload, the idle lock, or a password changed on another device. */
export type LockReason = "reload" | "idle" | "password-changed";

export interface UnlockScreenCopy {
  title: string;
  subtitle: Record<LockReason, string>;
  passwordLabel: string;
  submit: string;
  unlocking: string;
  wrong: string;
  signOut: string;
  discard: string;
  discardTitle: string;
  discardBody: string;
  discardConfirm: string;
  discarding: string;
  cancel: string;
  /** Shown when signing out or discarding failed; nothing was changed. */
  actionFailed: string;
}

export const DEFAULT_UNLOCK_COPY: UnlockScreenCopy = {
  title: "Unlock",
  subtitle: {
    reload: "Enter your password to open the data saved on this device.",
    idle: "Locked after a period of inactivity. Enter your password to continue.",
    "password-changed":
      "The data on this device was saved under your previous password. Enter that password to keep it, including changes not yet synced.",
  },
  passwordLabel: "Password",
  submit: "Unlock",
  unlocking: "Unlocking…",
  wrong: "That password does not open the data on this device.",
  signOut: "Sign out (keeps the data on this device)",
  discard: "I don't know the previous password",
  discardTitle: "Discard the data on this device?",
  discardBody:
    "Changes made on this device that have not synced will be lost for good. Everything else downloads again from the server.",
  discardConfirm: "Discard and continue",
  discarding: "Discarding…",
  cancel: "Cancel",
  actionFailed: "That did not work. Check your connection and try again.",
};

/**
 * Reopens the encrypted store after a reload or the idle lock by deriving the key from
 * the password again. Never calls the network, so it works offline. A wrong password
 * leaves the store untouched; signing out from here keeps it.
 */
export function UnlockScreen({
  email,
  reason,
  onUnlock,
  onSignOut,
  onDiscard,
  copy: overrides,
}: {
  email: string | null;
  reason: LockReason;
  onUnlock: (password: string) => Promise<UnlockResult>;
  onSignOut: () => Promise<void>;
  onDiscard: () => Promise<void>;
  copy?: Partial<UnlockScreenCopy>;
}) {
  const copy = { ...DEFAULT_UNLOCK_COPY, ...overrides };
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const errorId = useId();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setWrong(false);
    setFailed(false);
    try {
      const result = await onUnlock(password);
      if (result === "ok" || result === "recover") return; // the provider moves on
      setWrong(true);
      setPassword("");
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <main className="ss-screen">
      <div className="ss-panel">
        <h1 className="ss-title">{copy.title}</h1>
        <p className="ss-text">{copy.subtitle[reason]}</p>
        {email && (
          <p className="ss-text ss-strong">
            <bdi>{email}</bdi>
          </p>
        )}
        <form onSubmit={onSubmit} className="ss-form" noValidate>
          <label className="ss-label">
            <span>{copy.passwordLabel}</span>
            <input
              type="password"
              autoComplete="current-password"
              // biome-ignore lint/a11y/noAutofocus: the password is the only thing to do on this screen
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={wrong}
              aria-describedby={wrong ? errorId : undefined}
              className="ss-input"
            />
          </label>
          {wrong && (
            <p id={errorId} role="alert" className="ss-error">
              {copy.wrong}
            </p>
          )}
          {failed && (
            <p role="alert" className="ss-error">
              {copy.actionFailed}
            </p>
          )}
          <button type="submit" className="ss-button ss-button-primary" disabled={busy || !password} aria-busy={busy}>
            {busy ? copy.unlocking : copy.submit}
          </button>
        </form>
        <div className="ss-links">
          {reason === "password-changed" && (
            <button type="button" className="ss-link" onClick={() => setConfirming(true)} disabled={busy}>
              {copy.discard}
            </button>
          )}
          <button type="button" className="ss-link" onClick={() => void run(onSignOut)} disabled={busy}>
            {copy.signOut}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title={copy.discardTitle}
        body={copy.discardBody}
        confirmLabel={copy.discardConfirm}
        busyLabel={copy.discarding}
        cancelLabel={copy.cancel}
        destructive
        busy={busy}
        onConfirm={() => void run(onDiscard)}
        onCancel={() => setConfirming(false)}
      />
    </main>
  );
}
