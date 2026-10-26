export { ConfirmDialog } from "./components/confirm-dialog.tsx";
export {
  type SamesightContextValue,
  SamesightProvider,
  type SamesightProviderProps,
  type SamesightState,
  type SignOutResult,
  useSamesight,
} from "./components/provider.tsx";
export { DEFAULT_RECOVER_COPY, RecoverScreen, type RecoverScreenCopy } from "./components/recover-screen.tsx";
export {
  DEFAULT_REJECTED_WRITES_COPY,
  RejectedWritesBanner,
  type RejectedWritesCopy,
} from "./components/rejected-writes-banner.tsx";
export { type ChipCopy, SyncStatusChip } from "./components/sync-status-chip.tsx";
export { DEFAULT_UNLOCK_COPY, type LockReason, UnlockScreen, type UnlockScreenCopy } from "./components/unlock-screen.tsx";
export { DEFAULT_IDLE_MS, IdleLock } from "./session/idle-lock.tsx";
export {
  endSession,
  lockStore,
  SIGN_OUT_TIMEOUT_MS,
  type SessionTarget,
  signOutAndWipe,
  signOutKeeping,
  unsyncedCount,
} from "./session/session-client.ts";
export { clearStoredSession, storedSession } from "./session/stored-session.ts";
export {
  createEncryptedStore,
  type EncryptedStore,
  type EncryptedStoreOptions,
  type ProbeResult,
} from "./store/db.ts";
export { PBKDF2_ITERATIONS } from "./store/kdf.ts";
export { deriveAndHoldKey, tryUnlock, type UnlockResult } from "./store/unlock.ts";
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
} from "./sync-state.ts";
