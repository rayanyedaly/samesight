/**
 * Sync state for the status indicator, independent of any UI framework. Views derive
 * tone, icon and label from this resolver, so different surfaces cannot drift apart.
 *
 * Offline is calm, not an error: the tone is never red, a local read never spins, and
 * only `syncing` (flushing a queue while online) animates.
 */

export type SyncStatus = "synced" | "syncing" | "offline";
/** `compact`: a short chip in a top bar. `comfortable`: a card with a title and subtitle. */
export type SyncProfile = "compact" | "comfortable";

/** Visual tone. Deliberately has no error member: offline is not a failure. */
export type SyncTone = "positive" | "neutral" | "warm";

/** Which glyph the view renders (each surface maps this to its own icon set). */
export type SyncIcon = "check" | "spinner" | "device";

export interface SyncPresentation {
  status: SyncStatus;
  tone: SyncTone;
  icon: SyncIcon;
  /** Whether to show the pending-count badge (only when there is a queue to show). */
  showCount: boolean;
  count: number;
  /** Short chip label. */
  label: string;
  /** Card title. */
  title: string;
  /** Card subtitle, without a count (the count is surfaced through `count` and `pending`). */
  subtitle: string;
  /** Suffix after the pending count in the badge, e.g. "waiting to sync". */
  pending: string;
  /** True only for `syncing`, the one animated state; respect prefers-reduced-motion. */
  animated: boolean;
}

const TONE: Record<SyncStatus, SyncTone> = {
  synced: "positive",
  syncing: "neutral",
  offline: "warm",
};

const ICON: Record<SyncStatus, SyncIcon> = {
  synced: "check",
  syncing: "spinner",
  offline: "device",
};

export interface SyncCopy {
  label: string;
  title: string;
  /** Subtitle without a count; the count is surfaced by the badge (`count` + `pending`). */
  subtitle: string;
  /** Badge suffix after the count, e.g. "waiting to sync". */
  pending?: string;
}

/**
 * English defaults per profile. Subtitles carry no count, so a zero or missing count
 * can never render "0 left" or "NaN". Apps localize by passing `copy`.
 */
export const DEFAULT_SYNC_COPY: Record<SyncProfile, Record<SyncStatus, SyncCopy>> = {
  compact: {
    synced: { label: "Synced", title: "Synced", subtitle: "Everything's up to date" },
    syncing: { label: "Syncing", title: "Syncing", subtitle: "Sending changes", pending: "pending" },
    offline: {
      label: "Saved on device",
      title: "Offline, changes queued",
      subtitle: "Syncs when you're back online",
      pending: "pending",
    },
  },
  comfortable: {
    synced: { label: "Up to date", title: "Up to date", subtitle: "Everything's saved and synced" },
    syncing: { label: "Syncing…", title: "Syncing…", subtitle: "Catching up…", pending: "waiting to sync" },
    offline: {
      label: "Saved on this device",
      title: "Saved on this device",
      subtitle: "Syncs when you're back online",
      pending: "waiting to sync",
    },
  },
};

export interface ResolveSyncOptions {
  profile?: SyncProfile;
  pendingCount?: number;
  /** Replace the English defaults with localized strings. */
  copy?: Record<SyncStatus, SyncCopy>;
}

/**
 * Map a sync status and pending count to everything a view needs. `showCount` is true
 * only when there is a queue worth surfacing (syncing or offline with count > 0); a
 * synced indicator never shows a badge.
 */
export function resolveSyncState(status: SyncStatus, opts: ResolveSyncOptions = {}): SyncPresentation {
  const profile: SyncProfile = opts.profile ?? "compact";
  // A non-finite pendingCount collapses to 0, never a "NaN" badge.
  const raw = opts.pendingCount ?? 0;
  const count = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  const copy = opts.copy ?? DEFAULT_SYNC_COPY[profile];
  const c = copy[status];
  const showCount = (status === "offline" || status === "syncing") && count > 0;

  return {
    status,
    tone: TONE[status],
    icon: ICON[status],
    showCount,
    count,
    label: c.label,
    title: c.title,
    subtitle: c.subtitle,
    pending: c.pending ?? "",
    animated: status === "syncing",
  };
}

/** The three states, in display order. */
export const SYNC_STATUSES: readonly SyncStatus[] = ["synced", "syncing", "offline"] as const;

/**
 * Map PowerSync's connection state to the indicator status. The one path to "synced"
 * is connected, idle and an empty queue: showing "synced" while writes are still
 * queued would have someone trust work that has not reached the server.
 *
 * `pending` is null when the queue could not be read, which counts as non-empty.
 */
export function resolveChipStatus(connected: boolean, flowing: boolean, pending: number | null): SyncStatus {
  if (!connected) return "offline";
  if (flowing || pending === null || pending > 0) return "syncing";
  return "synced";
}
