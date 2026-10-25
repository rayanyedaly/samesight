"use client";

import { PowerSyncContext, useQuery, useStatus } from "@powersync/react";
import { useContext, useEffect, useRef, useState } from "react";
import {
  resolveChipStatus,
  resolveSyncState,
  type SyncCopy,
  type SyncProfile,
  type SyncStatus,
} from "../sync-state";

export interface ChipCopy {
  states?: Record<SyncStatus, SyncCopy>;
  /** Shown while there is unsynced exposure, e.g. "Last synced 5 minutes ago". */
  lastSynced?: (relative: string) => string;
  neverSynced?: string;
}

// PowerSync's upload queue. A watched query re-runs whenever a write is queued or
// uploaded, so the count is live without polling.
const QUEUE_COUNT_SQL = "SELECT COUNT(*) AS count FROM ps_crud";

/**
 * Sync indicator driven by PowerSync's real state, never a timer. The one path to
 * "synced" is connected, idle and an empty upload queue.
 *
 * While there is exposure (offline, or writes still queued) it also shows how long ago
 * the device last synced: until then, those writes exist only on this device.
 *
 * Outside the provider's ready state there is no PowerSync context; it then shows a
 * calm offline chip rather than throwing.
 */
export function SyncStatusChip({
  profile = "compact",
  copy,
  locale,
}: {
  profile?: SyncProfile;
  copy?: ChipCopy;
  /** For the relative time; defaults to the page's `lang`, then the browser's. */
  locale?: string;
}) {
  const db = useContext(PowerSyncContext);
  return db ? (
    <LiveChip profile={profile} copy={copy} locale={locale} />
  ) : (
    <ChipView status="offline" pending={0} lastSyncedAt={null} profile={profile} copy={copy} locale={locale} />
  );
}

function LiveChip({ profile, copy, locale }: { profile: SyncProfile; copy?: ChipCopy; locale?: string }) {
  const status = useStatus();
  const queue = useQuery<{ count: number }>(QUEUE_COUNT_SQL);
  const [, tick] = useState(0);

  // Advance "last synced X ago" between sync events.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Unknown (loading or unreadable) counts as non-empty: never "synced" on a guess.
  const pending = queue.error || queue.isLoading ? null : Number(queue.data[0]?.count ?? 0);
  const flowing = Boolean(status.dataFlowStatus?.downloading || status.dataFlowStatus?.uploading);
  const resolved = resolveChipStatus(status.connected, flowing, pending);
  const announcement = useTransitionAnnouncement(resolved, profile, copy);

  return (
    <>
      <span className="ss-sr-only" role="status">
        {announcement}
      </span>
      <ChipView
      status={resolved}
      pending={pending ?? 0}
      lastSyncedAt={status.lastSyncedAt ?? null}
      profile={profile}
      copy={copy}
      locale={locale}
      />
    </>
  );
}

/**
 * What a screen reader hears: only real transitions (going offline, coming back, and
 * everything saved after a wait), not every queued write flipping the chip. The visible
 * chip is not a live region.
 */
function useTransitionAnnouncement(status: SyncStatus, profile: SyncProfile, copy?: ChipCopy): string {
  const [message, setMessage] = useState("");
  const previous = useRef<{ status: SyncStatus; since: number } | null>(null);
  useEffect(() => {
    const before = previous.current;
    if (before?.status === status) return;
    previous.current = { status, since: Date.now() };
    if (!before) return;
    const label = resolveSyncState(status, { profile, pendingCount: 0, copy: copy?.states }).label;
    // Going offline or coming back is always news. "Saved" is, only after a wait: a quick
    // save-and-upload is not announced.
    // Cleared first, so the same message twice (offline, back, offline) is announced again.
    const announce = () => {
      setMessage("");
      setTimeout(() => setMessage(label), 100);
    };
    if (status === "offline" || before.status === "offline") announce();
    else if (status === "synced" && Date.now() - before.since > 3000) announce();
  }, [status, profile, copy]);
  return message;
}

function relativeTime(date: Date, locale?: string): string {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const lang = locale ?? (typeof document !== "undefined" ? document.documentElement.lang || undefined : undefined);
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

function ChipView({
  status,
  pending,
  lastSyncedAt,
  profile,
  copy,
  locale,
}: {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: Date | null;
  profile: SyncProfile;
  copy?: ChipCopy;
  locale?: string;
}) {
  const s = resolveSyncState(status, { profile, pendingCount: pending, copy: copy?.states });
  const lastSynced = copy?.lastSynced ?? ((t: string) => `Last synced ${t}`);
  const durability =
    status === "synced"
      ? null
      : lastSyncedAt
        ? lastSynced(relativeTime(lastSyncedAt, locale))
        : (copy?.neverSynced ?? "Not synced yet on this device");

  return (
    <div className="ss-chip-row">
      <span className={`ss-chip ss-chip-${s.tone}`}>
        <span className={s.animated ? "ss-dot ss-dot-animated" : "ss-dot"} aria-hidden="true" />
        <span>{s.label}</span>
        {s.showCount && (
          <span className="ss-chip-count">
            {s.count} {s.pending}
          </span>
        )}
      </span>
      {durability && <span className="ss-chip-note">{durability}</span>}
    </div>
  );
}
