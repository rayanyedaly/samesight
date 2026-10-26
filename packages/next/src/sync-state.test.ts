import { describe, expect, it } from "vitest";
import { DEFAULT_SYNC_COPY, resolveChipStatus, resolveSyncState, SYNC_STATUSES } from "./sync-state.ts";

describe("resolveSyncState", () => {
  it("resolves all three states with an icon and a label", () => {
    expect(SYNC_STATUSES).toEqual(["synced", "syncing", "offline"]);
    for (const status of SYNC_STATUSES) {
      const s = resolveSyncState(status);
      expect(s.icon).toBeTruthy();
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("is never red: no tone maps to an error hue", () => {
    const tones = SYNC_STATUSES.map((s) => resolveSyncState(s).tone);
    expect(tones).toEqual(["positive", "neutral", "warm"]);
    expect(tones).not.toContain("critical");
    expect(tones).not.toContain("error");
  });

  it("only `syncing` animates (a local read never spins)", () => {
    expect(resolveSyncState("synced").animated).toBe(false);
    expect(resolveSyncState("offline").animated).toBe(false);
    expect(resolveSyncState("syncing").animated).toBe(true);
  });

  it("shows the pending badge only when there is a queue to surface", () => {
    expect(resolveSyncState("synced", { pendingCount: 3 }).showCount).toBe(false);
    expect(resolveSyncState("offline", { pendingCount: 0 }).showCount).toBe(false);
    expect(resolveSyncState("offline", { pendingCount: 3 }).showCount).toBe(true);
    expect(resolveSyncState("syncing", { pendingCount: 2 }).showCount).toBe(true);
  });

  it("keeps subtitles countless: the count rides the badge, never '0 left' or 'NaN'", () => {
    const two = resolveSyncState("syncing", { profile: "comfortable", pendingCount: 2 });
    expect(two.title).toBe("Syncing…");
    expect(two.subtitle).toBe("Catching up…");
    expect(two.count).toBe(2);
    expect(two.showCount).toBe(true);
    const zero = resolveSyncState("syncing", { profile: "comfortable", pendingCount: 0 });
    expect(zero.subtitle).toBe("Catching up…");
    expect(zero.showCount).toBe(false);
    const nan = resolveSyncState("syncing", { profile: "comfortable", pendingCount: Number.NaN });
    expect(nan.count).toBe(0);
    expect(nan.showCount).toBe(false);
  });

  it("exposes a localizable pending-count suffix", () => {
    expect(resolveSyncState("offline", { profile: "comfortable", pendingCount: 3 }).pending).toBe("waiting to sync");
    const ar = {
      synced: { label: "", title: "", subtitle: "" },
      syncing: { label: "", title: "", subtitle: "", pending: "قيد المزامنة" },
      offline: { label: "", title: "", subtitle: "", pending: "قيد المزامنة" },
    };
    expect(resolveSyncState("offline", { pendingCount: 3, copy: ar }).pending).toBe("قيد المزامنة");
  });

  it("offline is 'saved', not a failure, in both profiles", () => {
    expect(resolveSyncState("offline", { profile: "compact" }).label).toBe("Saved on device");
    expect(resolveSyncState("offline", { profile: "comfortable" }).title).toBe("Saved on this device");
    expect(DEFAULT_SYNC_COPY.comfortable.offline.subtitle).toContain("back online");
  });

  it("accepts localized copy overrides", () => {
    const fr = {
      synced: { label: "Synchronisé", title: "Synchronisé", subtitle: "" },
      syncing: { label: "Synchro…", title: "Synchro…", subtitle: "" },
      offline: { label: "Enregistré", title: "Enregistré sur cet appareil", subtitle: "" },
    };
    expect(resolveSyncState("offline", { copy: fr }).label).toBe("Enregistré");
  });
});

// The one path to "synced" is connected, idle and an empty queue. The dangerous silent
// break is "synced" while offline with queued writes.
describe("resolveChipStatus", () => {
  it("offline whenever disconnected, whatever the flow or queue", () => {
    expect(resolveChipStatus(false, false, 0)).toBe("offline");
    expect(resolveChipStatus(false, true, 5)).toBe("offline");
  });

  it("syncing when connected and data is flowing or the queue is not empty", () => {
    expect(resolveChipStatus(true, true, 0)).toBe("syncing");
    expect(resolveChipStatus(true, false, 1)).toBe("syncing");
  });

  it("an unreadable queue never counts as empty", () => {
    expect(resolveChipStatus(true, false, null)).toBe("syncing");
  });

  it("synced only when connected, idle, and the queue is empty", () => {
    expect(resolveChipStatus(true, false, 0)).toBe("synced");
  });
});
