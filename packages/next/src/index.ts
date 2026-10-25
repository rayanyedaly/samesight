export { ConfirmDialog } from "./components/confirm-dialog";
export {
  type SamesightContextValue,
  SamesightProvider,
  type SamesightProviderProps,
  type SamesightState,
  type SignOutResult,
  useSamesight,
} from "./components/provider";
export { DEFAULT_RECOVER_COPY, RecoverScreen, type RecoverScreenCopy } from "./components/recover-screen";
export {
  DEFAULT_REJECTED_WRITES_COPY,
  RejectedWritesBanner,
  type RejectedWritesCopy,
} from "./components/rejected-writes-banner";
export { type ChipCopy, SyncStatusChip } from "./components/sync-status-chip";
export { DEFAULT_UNLOCK_COPY, type LockReason, UnlockScreen, type UnlockScreenCopy } from "./components/unlock-screen";
export { DEFAULT_IDLE_MS, IdleLock } from "./session/idle-lock";
export {
  endSession,
  lockStore,
  SIGN_OUT_TIMEOUT_MS,
  type SessionTarget,
  signOutAndWipe,
  signOutKeeping,
  unsyncedCount,
} from "./session/session-client";
export { clearStoredSession, storedSession } from "./session/stored-session";
export {
  createEncryptedStore,
  type EncryptedStore,
  type EncryptedStoreOptions,
  type ProbeResult,
} from "./store/db";
export { PBKDF2_ITERATIONS } from "./store/kdf";
export { deriveAndHoldKey, tryUnlock, type UnlockResult } from "./store/unlock";
export {
  DEFAULT_SYNC_COPY,
  type ResolveSyncOptions,
  resolveChipStatus,
  resolveSyncState,
  SYNC_STATUSES,
  type SyncCopy,
  type SyncIcon,
  type SyncPresentation,
  type SyncProfile,
  type SyncStatus,
  type SyncTone,
} from "./sync-state";
