"use client";

import { useEffect, useId, useRef } from "react";

/**
 * A blocking confirmation for actions that destroy data.
 *
 * A native modal <dialog>: the browser makes the page behind it inert and keeps focus
 * inside. Not dismissible by clicking away: the paths that reach it can discard unsynced
 * writes for good, and clicking next to the box must not be a way to do that. Escape
 * cancels (the safe direction). Focus starts on Cancel and returns on close. While the
 * action runs (`busy`) nothing cancels it: the dialog would close while the data is
 * being destroyed anyway.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busyLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** Shown on the confirm button while `busy`; defaults to `confirmLabel`. */
  busyLabel?: string;
  cancelLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const handlers = useRef({ onCancel, busy });
  handlers.current = { onCancel, busy };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // Focus the safe action, so a stray Enter cancels.
    cancelRef.current?.focus();
    const onEscape = (e: Event) => {
      e.preventDefault();
      if (!handlers.current.busy) handlers.current.onCancel();
    };
    dialog.addEventListener("cancel", onEscape);
    return () => {
      dialog.removeEventListener("cancel", onEscape);
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, [open]);

  // Keep focus in the dialog when the focused confirm button becomes disabled.
  useEffect(() => {
    if (busy && open) dialogRef.current?.focus();
  }, [busy, open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      aria-busy={busy}
      tabIndex={-1}
      className="ss-dialog"
    >
      <h2 id={`${id}-title`} className="ss-dialog-title">
        {title}
      </h2>
      <p id={`${id}-body`} className="ss-dialog-body">
        {body}
      </p>
      <div className="ss-dialog-actions">
        <button ref={cancelRef} type="button" className="ss-button" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={destructive ? "ss-button ss-button-danger" : "ss-button ss-button-primary"}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
