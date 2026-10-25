"use client";

import { usePowerSync, useQuery } from "@powersync/react";
import { acknowledgeRejection, type RejectedWriteRow, UNACKNOWLEDGED_REJECTIONS_SQL } from "@samesight/supabase";
import { useId, useRef, useState } from "react";

export interface RejectedWritesCopy {
  title: (count: number) => string;
  body: string;
  show: string;
  hide: string;
  reason: (row: RejectedWriteRow) => string;
  acknowledge: string;
  acknowledgeFailed: string;
}

export const DEFAULT_REJECTED_WRITES_COPY: RejectedWritesCopy = {
  title: (count) => (count === 1 ? "1 change was not saved" : `${count} changes were not saved`),
  body: "The server refused these changes, so they are no longer queued. Their content is below so you can enter them again.",
  show: "Show",
  hide: "Hide",
  reason: (row) => `${row.opType} ${row.resourceType} refused (${row.reasonCode}): ${row.reasonMessage}`,
  acknowledge: "Mark as seen",
  acknowledgeFailed: "Could not mark this as seen. Try again.",
};

/**
 * "These changes did not save."
 *
 * The counterpart to the connector's dead-letter handover: when the server refuses a
 * batch for good, the connector takes it out of the upload queue (or one bad write
 * would block every write behind it) after recording it in the local RejectedWrite
 * table. This banner puts that record in front of the person who wrote it.
 *
 * Not a toast: it stays until each row is acknowledged, and it shows the content so the
 * write can be entered again. Acknowledging marks a row; it never deletes it.
 * Render it inside the provider's ready state.
 */
export function RejectedWritesBanner({ copy: overrides }: { copy?: Partial<RejectedWritesCopy> }) {
  const copy = { ...DEFAULT_REJECTED_WRITES_COPY, ...overrides };
  const { data: rejections } = useQuery<RejectedWriteRow>(UNACKNOWLEDGED_REJECTIONS_SQL);
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  if (rejections.length === 0) return null;

  // Only the title is a live region: the payloads must not be read out as an alert.
  return (
    <section aria-labelledby={titleId} className="ss-banner">
      <div className="ss-banner-head">
        <div>
          <p id={titleId} className="ss-strong" role="alert">
            {copy.title(rejections.length)}
          </p>
          <p>{copy.body}</p>
        </div>
        <button
          ref={toggleRef}
          type="button"
          className="ss-button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? copy.hide : copy.show}
        </button>
      </div>
      {expanded && (
        <ul id={listId} className="ss-banner-list">
          {rejections.map((row, i) => (
            <RejectedRow
              key={row.id}
              row={row}
              copy={copy}
              // The row unmounts once acknowledged: move focus to the next one, or back to the toggle.
              onAcknowledged={(list) => {
                const buttons = list?.querySelectorAll<HTMLButtonElement>("[data-ss-ack]");
                const next = buttons?.[i + 1] ?? buttons?.[i - 1];
                (next ?? toggleRef.current)?.focus();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RejectedRow({
  row,
  copy,
  onAcknowledged,
}: {
  row: RejectedWriteRow;
  copy: RejectedWritesCopy;
  onAcknowledged: (list: HTMLElement | null) => void;
}) {
  const db = usePowerSync();
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const itemRef = useRef<HTMLLIElement>(null);

  async function acknowledge() {
    setBusy(true);
    setFailed(false);
    try {
      onAcknowledged(itemRef.current?.parentElement ?? null);
      await acknowledgeRejection(db, row.id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  // Shown verbatim: it is the person's own content and the only copy left on this device.
  let content = row.payload;
  try {
    content = JSON.stringify(JSON.parse(row.payload), null, 1);
  } catch {
    // Keep the raw string.
  }

  return (
    <li ref={itemRef} className="ss-banner-item">
      <div className="ss-banner-head">
        <span id={reasonId} className="ss-strong">
          {copy.reason(row)}
        </span>
        <button
          type="button"
          className="ss-button"
          data-ss-ack=""
          aria-describedby={reasonId}
          disabled={busy}
          onClick={() => void acknowledge()}
        >
          {copy.acknowledge}
        </button>
      </div>
      {failed && (
        <p className="ss-error" role="alert">
          {copy.acknowledgeFailed}
        </p>
      )}
      <pre className="ss-pre" dir="auto">
        {content}
      </pre>
    </li>
  );
}
