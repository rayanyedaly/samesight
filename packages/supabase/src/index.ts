export { type StuckUpload, SupabaseConnector, type SupabaseConnectorOptions } from "./connector.ts";
export { classifyUploadError, isPermanentRejection, type UploadFailure, type UploadOutcome } from "./errors.ts";
export { earlierVersions, latestOnly, type SupersedingRow } from "./latest-only.ts";
export { hasUnsyncedWrites, pendingUploadCount } from "./queue.ts";
export {
  acknowledgeRejection,
  type CrudOpPayload,
  localUuid,
  type RejectedUpload,
  type RejectedWriteRow,
  recordRejectedLocally,
  rejectedWriteTable,
  UNACKNOWLEDGED_REJECTIONS_SQL,
} from "./rejected-writes.ts";
