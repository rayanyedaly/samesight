import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { TableModel } from "./model.ts";
import fc from "fast-check";
import { columnArbitrary, insertWorld, type World } from "./world.ts";

describe("insertWorld with a key pool", () => {
  const orgs: TableModel = {
    name: "orgs",
    primaryKey: ["id"],
    unique: ["id"],
    columns: [{ name: "id", type: "uuid", nullable: false, hasDefault: false, computed: false, hints: [] }],
    foreignKeys: [],
    keyPool: { column: "id", values: ["5a3e5a3e-0000-4000-8000-00000000000a", "refused", "5a3e5a3e-0000-4000-8000-00000000000b"] },
  };
  const world: World = { orgs: [0, 1, 2, 3].map(() => ({ tenant: 0, picks: [], values: {} })) };

  it("gives the first rows the pool's keys, each tried once, so a refused key costs one row", async () => {
    const ids: unknown[] = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("insert")) {
          if (params?.[0] === "refused") throw new Error("invalid input syntax for type uuid");
          ids.push(params?.[0]);
        }
        return { rows: [] };
      },
    } as unknown as pg.Client;
    const done = await insertWorld(client, [orgs], world, { prefix: "5a3e5a3e", tenants: [], users: [] });
    expect(done.map((d) => d.row.id)).toEqual(ids);
    expect(ids.slice(0, 2)).toEqual(["5a3e5a3e-0000-4000-8000-00000000000a", "5a3e5a3e-0000-4000-8000-00000000000b"]);
    // The fourth row is past the pool: a fresh run key.
    expect(ids).toHaveLength(3);
    expect(String(ids[2])).toMatch(/^5a3e5a3e-/);
    expect(ids[2]).not.toBe(ids[1]);
  });
});

describe("columnArbitrary with claim values", () => {
  it("draws the values run users hold often, and leaves other columns as they were", () => {
    const base = { name: "code", type: "text", nullable: false, hasDefault: false, computed: false, hints: [] };
    const drawn = fc.sample(columnArbitrary({ ...base, claimValues: ["ss-a", "ss-b"] }) as fc.Arbitrary<unknown>, { numRuns: 200, seed: 1 });
    const held = drawn.filter((v) => v === "ss-a" || v === "ss-b").length;
    expect(held).toBeGreaterThan(50);
    expect(fc.sample(columnArbitrary(base) as fc.Arbitrary<unknown>, { numRuns: 200, seed: 1 }).filter((v) => v === "ss-a" || v === "ss-b")).toEqual([]);
  });
});
