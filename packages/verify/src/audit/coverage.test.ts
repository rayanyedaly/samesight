import { parseSyncConfig } from "samesight/compiler";
import { describe, expect, it } from "vitest";
import type { DeviceRow } from "../differential/device.ts";
import type { Run } from "../differential/run.ts";
import type { Inserted } from "../differential/world.ts";
import { type Coverage, coverageFindings, measure, pending, type ScopedPolicy, type StreamUnit, stateOf, streamUnits, untested } from "./coverage.ts";

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

describe("coverageFindings", () => {
  const policy = (name: string, allowed: number, refused: number, more: Partial<ScopedPolicy> = {}): ScopedPolicy => ({
    table: "docs",
    name,
    permissive: true,
    qual: "true",
    sameForAll: false,
    claims: [],
    reachable: true,
    tally: { allowed, refused },
    ...more,
  });
  const unit = (streams: string[], allowed: number, refused: number, claims: string[] = []): StreamUnit => ({ streams, table: "docs", claims, reachable: true, tally: { allowed, refused } });
  const cov = (policies: ScopedPolicy[], units: StreamUnit[], inserted = 3): Coverage => ({
    policies,
    units,
    inserted: new Map([["docs", inserted]]),
    datasets: 2,
    triggers: [],
    notes: [],
  });
  const lines = (c: Coverage, held: string[] = ["app_metadata.role"], together = false) => coverageFindings(c, new Set(held), together).map((f) => `${f.status} ${f.detail}`);

  it("sums up, then names each rule seen one way, with the side and why", () => {
    const c = cov(
      [
        policy("owners", 4, 8),
        policy("editors", 0, 9, { claims: ["app_metadata.role"] }),
        policy("orgs", 0, 9, { claims: ["app_metadata.org_id"], reachable: false }),
        policy("visible", 3, 0, { permissive: false }),
        policy("everyone", 12, 0, { sameForAll: true }),
      ],
      [unit(["own"], 2, 5), unit(["editor", "admin"], 0, 12, ["app_metadata.role"])],
    );
    expect(lines(c)).toEqual([
      "ok 1 of 5 RLS read policies on synced tables was seen both allowing and refusing a run user a row; 4 were not (below). 1 of 2 stream/table pairs both sent and withheld a row.",
      'warn policy "editors" on docs: only refused rows seen (no generated row matched it)',
      'warn policy "orgs" on docs: only refused rows seen (it reads app_metadata.org_id, which no run user holds; see Claims)',
      'warn policy "visible" on docs (restrictive): only allowed rows seen (it kept out no row the other policies let through)',
      'ok policy "everyone" on docs: only allowed rows seen; it reads nothing of the user, so it applies to every user alike',
      "warn streams editor + admin (one bucket), docs: only withheld rows seen (no generated row matched it)",
    ]);
    // The rule that applies to every user alike is not owned up to on the Differential line.
    expect(untested(c)).toBe(4);
  });

  it("gives the reason a run can tell: no row, values held only apart, another policy, a read error", () => {
    expect(lines(cov([policy("p", 0, 0)], [], 0))).toContain('warn policy "p" on docs: no row seen either way (no docs row was inserted)');
    expect(lines(cov([policy("p", 0, 4, { claims: ["app_metadata.a", "app_metadata.b"] })], []), ["app_metadata.a", "app_metadata.b"], true)).toContain(
      'warn policy "p" on docs: only refused rows seen (no run user holds the values it needs together)',
    );
    expect(lines(cov([policy("p", 0, 0)], []))).toContain('warn policy "p" on docs: no row seen either way (every row it kept from a user, another policy let through)');
    expect(lines(cov([policy("p", 1, 1, { tally: { allowed: 1, refused: 1, error: "invalid input syntax for type uuid" } })], []))).toContain(
      'warn policy "p" on docs: a read failed, so it was not measured (invalid input syntax for type uuid)',
    );
  });

  it("measures no policy when an event trigger would run, and says so through its notes", () => {
    const c = { ...cov([policy("p", 0, 0)], [unit(["own"], 1, 1)]), triggers: ["audit_ddl (log_ddl)"] };
    expect(lines(c)).toEqual(["ok 1 of 1 stream/table pair both sent and withheld a row."]);
    expect(untested(c)).toBe(0);
  });
});
