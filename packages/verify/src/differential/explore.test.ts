import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Problem } from "./compare.ts";
import type { TableModel } from "./model.ts";
import { auditRefusals, explore, splitProblems, type UserProblems } from "./run.ts";
import type { Member } from "./world.ts";

describe("explore", () => {
  it("shrinks a failing world and counts only the datasets before the first failure", async () => {
    const x = await explore(fc.integer({ min: 0, max: 1000 }), async (n) => n < 10, { runs: 100, seed: 1, timeLimitMs: 60_000 });
    expect(x.lastFailing).toBe(10);
    expect(x.crash).toBeUndefined();
    expect(x.datasets).toBeGreaterThan(0);
    expect(x.datasets).toBeLessThanOrEqual(100);
  });

  it("stops at a crash: no run starts after it", async () => {
    let calls = 0;
    const x = await explore(
      fc.integer(),
      async () => {
        calls++;
        throw new Error("sync timed out");
      },
      { runs: 20, seed: 1, timeLimitMs: 60_000 },
    );
    expect(calls).toBe(1);
    expect(String(x.crash)).toMatch(/sync timed out/);
    expect(x.lastFailing).toBeUndefined();
  });

  it("keeps the failing world when a shrinking run crashes", async () => {
    let calls = 0;
    const x = await explore(
      fc.integer({ min: 1, max: 1000 }),
      async () => {
        if (calls++ > 0) throw new Error("crashed while shrinking");
        return false;
      },
      { runs: 20, seed: 3, timeLimitMs: 60_000 },
    );
    expect(x.lastFailing).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(2);
    expect(String(x.crash)).toMatch(/crashed while shrinking/);
  });

  it("never races a run: nothing is in flight when it returns, and nothing starts past the limit", async () => {
    let inFlight = 0;
    let calls = 0;
    const x = await explore(
      fc.integer(),
      async () => {
        calls++;
        inFlight++;
        await new Promise((r) => setTimeout(r, 120));
        inFlight--;
        return true;
      },
      { runs: 50, seed: 1, timeLimitMs: 50 },
    );
    expect(inFlight).toBe(0);
    expect(calls).toBe(1);
    expect(x.stopped).toBe(true);
    expect(x.datasets).toBe(1);
  });

  it("tests nothing when the limit is already past", async () => {
    const x = await explore(fc.integer(), async () => true, { runs: 5, seed: 1, timeLimitMs: -1 });
    expect(x.datasets).toBe(0);
    expect(x.stopped).toBe(true);
  });
});

describe("splitProblems", () => {
  const user = { id: "u", email: "", tenant: null, role: null, label: "u0" } as Member;
  const p = (kind: Problem["kind"]): Problem => ({ kind, table: "t", id: kind, streams: [], row: {} });
  const all: UserProblems[] = [{ user, problems: [p("leak"), p("gap"), p("unsent"), p("differs"), p("hidden")] }];
  const kinds = (u: UserProblems[]) => u.flatMap((x) => x.problems.map((q) => q.kind));

  it("fails on everything under a policy", () => {
    expect(kinds(splitProblems(all, "fail").failing)).toEqual(["leak", "gap", "unsent", "differs", "hidden"]);
  });

  it("only warns about narrower sync in an audit; leaks and differing values still fail", () => {
    const s = splitProblems(all, "warn");
    expect(kinds(s.failing)).toEqual(["leak", "differs", "hidden"]);
    expect(kinds(s.narrower)).toEqual(["gap", "unsent"]);
  });
});

describe("auditRefusals", () => {
  const table = (name: string, key: string[], columns: [string, string][], fks: string[][] = []): TableModel => ({
    name,
    primaryKey: key,
    unique: [],
    columns: columns.map(([n, type]) => ({ name: n, type, nullable: false, hasDefault: false, computed: false, hints: [] })),
    foreignKeys: fks.map((cols) => ({ columns: cols, schema: "auth", table: "users", references: ["id"] })),
  });

  it("accepts one uuid key of the table's own, whatever its name", () => {
    expect(auditRefusals([table("lists", ["id"], [["id", "uuid"]]), table("parents", ["uid"], [["uid", "uuid"]])], ["lists"])).toEqual([]);
  });

  it("refuses keys it could not find its rows by again", () => {
    expect(auditRefusals([table("a", ["id"], [["id", "bigint"]])], [])).toEqual([expect.stringMatching(/a is not keyed by one uuid column/)]);
    expect(auditRefusals([table("b", ["id"], [["id", "text"]])], [])).toHaveLength(1);
    expect(auditRefusals([table("c", ["x", "y"], [["x", "uuid"], ["y", "uuid"]])], [])).toHaveLength(1);
    expect(auditRefusals([table("profiles", ["id"], [["id", "uuid"]], [["id"]])], [])).toEqual([expect.stringMatching(/profiles.id is a foreign key/)]);
  });

  it("refuses a synced table without an id column", () => {
    expect(auditRefusals([table("t", ["uid"], [["uid", "uuid"]])], ["t"])).toEqual([expect.stringMatching(/t has no id column/)]);
  });
});
