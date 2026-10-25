"use client";

import { useQuery, useStatus } from "@powersync/react";

/**
 * Says "Synced" only when connected, finished downloading, and the upload queue is
 * known to be empty. Phase 2 replaces this with the @samesight/next status chip.
 */
export function SyncStatus() {
  const status = useStatus();
  const pending = usePendingUploads();
  const waiting = pending ? ` · ${pending} waiting` : "";

  let label: string;
  let tone: string;
  // Disconnected comes first: an unreachable server also sets downloadError, and that
  // is "offline", not a fault.
  if (!status.connected) {
    label = `Offline${waiting}`;
    tone = "bg-warn-soft text-warn";
  } else if (status.dataFlowStatus.uploadError || status.dataFlowStatus.downloadError || pending === null) {
    label = "Sync error";
    tone = "bg-danger-soft text-danger";
  } else if (!status.hasSynced || status.dataFlowStatus.downloading || pending !== 0) {
    label = `Syncing${waiting}`;
    tone = "bg-warn-soft text-warn";
  } else {
    label = "Synced";
    tone = "bg-ok-soft text-ok";
  }

  return (
    <span role="status" className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

/** Local writes not yet accepted by the server: undefined while loading, null if unreadable. */
export function usePendingUploads(): number | null | undefined {
  const { data, isLoading, error } = useQuery<{ n: number }>("SELECT count(*) AS n FROM ps_crud");
  if (error) return null;
  if (isLoading) return undefined;
  return data[0]?.n ?? 0;
}
