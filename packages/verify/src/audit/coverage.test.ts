import { parseSyncConfig } from "samesight/compiler";
import { describe, expect, it } from "vitest";
import type { DeviceRow } from "../differential/device.ts";
import type { Run } from "../differential/run.ts";
import type { Inserted } from "../differential/world.ts";
import { type Coverage, measure, pending, stateOf, streamUnits } from "./coverage.ts";

const streams = (yaml: string) => parseSyncConfig(`config:\n  edition: 3\nstreams:\n${yaml}`).streams;

describe("streamUnits", () => {
  it("gives each stream its own unit per table, with the claims that decide its rows", () => {
    const units = streamUnits(
      streams(`  own:
    auto_subscribe: true
    queries:
      - SELECT * FROM docs WHERE owner_id = auth.user_id()
      - SELECT * FROM orgs WHERE owner_id = auth.user_id()
  org:
    auto_subscribe: true
    queries:
      - SELECT * FROM docs WHERE org_id = auth.parameter('app_metadata') ->> 'org_id'
  later:
    queries:
      - SELECT * FROM docs
`),
    );
    expect(units.map((u) => [u.streams, u.table, u.claims])).toEqual([
      [["org"], "docs", ["app_metadata.org_id"]],
      [["own"], "docs", []],
      [["own"], "orgs", []],
    ]);
  });

  it("measures streams that share a bucket together: their queries differ only in claims compared with literals", () => {
    const units = streamUnits(
      streams(`  editor:
    auto_subscribe: true
    queries:
      - SELECT * FROM docs WHERE auth.parameter('$.app_metadata.role') = 'editor' AND status = 'published'
  admin:
    auto_subscribe: true
    queries:
      - SELECT * FROM docs WHERE status = 'published' AND auth.parameter('app_metadata') ->> 'role' = 'admin'
  drafts:
    auto_subscribe: true
    queries:
      - SELECT * FROM docs WHERE auth.parameter('$.app_metadata.role') = 'editor' AND status = 'draft'
`),
    );
    expect(units.map((u) => [u.streams, u.claims])).toEqual([
      [["drafts"], ["app_metadata.role"]],
      [["editor", "admin"], ["app_metadata.role"]],
    ]);
  });
});

describe("stateOf and pending", () => {
  it("names the side seen, and keeps passes going only for rules users can still exercise", () => {
    expect(stateOf({ allowed: 2, refused: 1 })).toBe("exercised");
    expect(stateOf({ allowed: 2, refused: 0 })).toBe("only allowed");
    expect(stateOf({ allowed: 0, refused: 3 })).toBe("only refused");
    expect(stateOf({ allowed: 0, refused: 0 })).toBe("not seen");
    const base: Coverage = { policies: [], units: [], inserted: new Map(), datasets: 0, triggers: [], notes: [] };
    const policy = (reachable: boolean, sameForAll: boolean, refused: number) => ({
      table: "t",
      name: "p",
      permissive: true,
      qual: "true",
      sameForAll,
      claims: [],
      reachable,
      tally: { allowed: 1, refused },
    });
    expect(pending({ ...base, policies: [policy(true, false, 0)] })).toBe(true);
    expect(pending({ ...base, policies: [policy(true, false, 1)] })).toBe(false);
    expect(pending({ ...base, policies: [policy(false, false, 0)] })).toBe(false);
    expect(pending({ ...base, policies: [policy(true, true, 0)] })).toBe(false);
  });
});

describe("measure, for streams", () => {
  const run = {
    fixed: { prefix: "5a3e5a3e", tenants: [], users: [{ id: "a" }, { id: "b" }] },
    sessions: new Map(),
  } as unknown as Run;
  const row = (table: string, id: string, stream: string): DeviceRow => ({ table, id, data: { id }, sources: [{ stream, columns: ["id"] }] });

  it("counts, per user and generated row, whether the unit's streams sent it", async () => {
    const cov: Coverage = {
      policies: [],
      units: [
        { streams: ["editor", "admin"], table: "docs", claims: [], reachable: true, tally: { allowed: 0, refused: 0 } },
        { streams: ["own"], table: "docs", claims: [], reachable: true, tally: { allowed: 0, refused: 0 } },
      ],
      inserted: new Map(),
      datasets: 0,
      triggers: [],
      notes: [],
    };
    const inserted: Inserted[] = ["r1", "r2", "r3"].map((id) => ({ table: "docs", row: { id }, tenant: null }));
    // "editor" names the shared bucket: its rows count for admin too. r9 is not one of the dataset's rows.
    const devices = new Map([
      ["a", [row("docs", "r1", "editor"), row("docs", "r2", "own"), row("docs", "r9", "own")]],
      ["b", []],
    ]);
    await measure(run, cov, inserted, devices);
    expect(cov.units.map((u) => u.tally)).toEqual([
      { allowed: 1, refused: 5 },
      { allowed: 1, refused: 5 },
    ]);
    expect(cov.inserted).toEqual(new Map([["docs", 3]]));
    expect(cov.datasets).toBe(1);
  });
});
