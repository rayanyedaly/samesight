export { type StuckUpload, SupabaseConnector, type SupabaseConnectorOptions } from "./connector";
export { classifyUploadError, isPermanentRejection, type UploadFailure, type UploadOutcome } from "./errors";
export { earlierVersions, latestOnly, type SupersedingRow } from "./latest-only";
export { hasUnsyncedWrites, pendingUploadCount } from "./queue";
export {
  acknowledgeRejection,
  type CrudOpPayload,
  localUuid,
  type RejectedUpload,
  type RejectedWriteRow,
  recordRejectedLocally,
  rejectedWriteTable,
  UNACKNOWLEDGED_REJECTIONS_SQL,
} from "./rejected-writes";
