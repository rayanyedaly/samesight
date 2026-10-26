import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compare, normalize } from "./compare.ts";
import { rowsFromOps, streamOfBucket } from "./device.ts";
import { type ColumnModel, insertOrder, parseCheck, type TableModel } from "./model.ts";
import { rowKey } from "./rls.ts";
import { columnArbitrary } from "./world.ts";

const column = (over: Partial<ColumnModel>): ColumnModel => ({ name: "c", type: "text", nullable: false, hasDefault: false, computed: false, hints: [], ...over });
const table = (name: string, fks: [string, string][] = []): TableModel => ({
  name,
  tenant: "tenantId",
  primaryKey: ["id"],
  unique: ["id"],
  columns: [column({ name: "id", type: "uuid" })],
  foreignKeys: fks.map(([c, t]) => ({ columns: [c], schema: "public", table: t, references: ["id"] })),
});

describe("parseCheck", () => {
  it("reads value lists and patterns as pg_get_constraintdef prints them", () => {
    expect(parseCheck("CHECK ((role = ANY (ARRAY['ADMIN'::text, 'INSPECTOR'::text, 'VIEWER'::text])))")).toEqual({ values: ["ADMIN", "INSPECTOR", "VIEWER"] });
    expect(parseCheck(`CHECK (("kind" = ANY (ARRAY['it''s'::text])))`)).toEqual({ values: ["it's"] });
    expect(parseCheck("CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))")).toEqual({ pattern: "^[0-9a-f]{64}$" });
    expect(parseCheck(`CHECK (("supersedesId" <> id))`)).toEqual({});
  });
});

describe("insertOrder", () => {
  it("puts parents first, allows self-references, and refuses a cycle", () => {
    const order = insertOrder([table("Finding", [["inspectionId", "Inspection"], ["supersedesId", "Finding"]]), table("Inspection", [["siteId", "Site"]]), table("Site")]);
    expect(order.map((t) => t.name)).toEqual(["Site", "Inspection", "Finding"]);
    expect(() => insertOrder([table("A", [["b", "B"]]), table("B", [["a", "A"]])])).toThrow(/cycle among A, B/);
  });
});

describe("columnArbitrary", () => {
  it("draws only allowed values, matches patterns, and leaves plain defaults alone", () => {
    const status = columnArbitrary(column({ values: ["DRAFT", "PUBLISHED"], hasDefault: true })) as fc.Arbitrary<unknown>;
    expect(new Set(fc.sample(status, 50))).toEqual(new Set(["DRAFT", "PUBLISHED"]));
    const sha = columnArbitrary(column({ pattern: "^[0-9a-f]{64}$" })) as fc.Arbitrary<unknown>;
    for (const v of fc.sample(sha, 20)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(columnArbitrary(column({ type: "timestamp with time zone", hasDefault: true }))).toBeUndefined();
    expect(columnArbitrary(column({ computed: true }))).toBeUndefined();
    const nullable = columnArbitrary(column({ nullable: true })) as fc.Arbitrary<unknown>;
    expect(fc.sample(nullable, 200)).toContain(null);
  });
});

describe("compare", () => {
  const model: TableModel[] = [{ ...table("Inspection"), columns: [column({ name: "id", type: "uuid" }), column({ name: "updatedAt", type: "timestamp with time zone" })] }];
  const rls = (rows: Record<string, unknown>[]) => new Map(rows.map((r) => [rowKey("Inspection", String(r.id)), r]));
  const device = (data: Record<string, unknown>, stream = "viewer") => ({ table: "Inspection", id: String(data.id), data, sources: [{ stream, columns: Object.keys(data) }] });

  it("agrees when both sides hold the same rows, whatever the timestamp spelling", () => {
    const row = { id: "a", updatedAt: "2026-10-25T20:36:06.271634+00:00", internalNotes: "x" };
    expect(compare([device({ id: "a", updatedAt: "2026-10-25 20:36:06.271634Z" })], rls([row]), new Map([["Inspection", ["internalNotes"]]]), model)).toEqual([]);
  });

  it("names leaks, hidden columns, gaps and differing values", () => {
    const problems = compare(
      [device({ id: "leak" }, "m3"), device({ id: "seen", internalNotes: "secret" }), device({ id: "stale", updatedAt: "2020-01-01T00:00:00Z" })],
      rls([{ id: "seen" }, { id: "gap" }, { id: "stale", updatedAt: "2021-01-01T00:00:00Z" }]),
      new Map([["Inspection", ["internalNotes"]]]),
      model,
    );
    expect(problems.map((p) => [p.kind, p.id, p.streams, p.columns])).toEqual([
      ["leak", "leak", ["m3"], undefined],
      ["hidden", "seen", ["viewer"], ["internalNotes"]],
      ["differs", "stale", ["viewer"], ["updatedAt"]],
      ["gap", "gap", [], undefined],
    ]);
  });

  it("names a column the device has that the table does not", () => {
    const problems = compare([device({ id: "a", list_name: "secret" })], rls([{ id: "a" }]), new Map(), model);
    expect(problems.map((p) => [p.kind, p.columns])).toEqual([["differs", ["list_name"]]]);
  });

  it("names a column the device lacks, but not a null it was never sent", () => {
    const problems = compare([device({ id: "a", status: null })], rls([{ id: "a", status: null, updatedAt: "2021-01-01T00:00:00Z", internalNotes: null }]), new Map(), model);
    expect(problems.map((p) => [p.kind, p.id, p.columns])).toEqual([["unsent", "a", ["updatedAt"]]]);
  });

  it("normalises the types PowerSync sends as text or integers", () => {
    expect(normalize("boolean", 1)).toBe(true);
    expect(normalize("bigint", "5")).toBe(5);
    expect(normalize("jsonb", '{"a":1}')).toBe(normalize("jsonb", { a: 1 }));
  });
});

describe("streamOfBucket", () => {
  it("takes the stream name between the version and the parameters", () => {
    expect(streamOfBucket('3#inspector|1["t","u"]')).toBe("inspector");
    expect(streamOfBucket('user_lists["5a3e5a3e-0000-4000-8000-000000000001"]')).toBe("user_lists");
    expect(streamOfBucket("global[]")).toBe("global");
    expect(streamOfBucket('by_email["a#b@x.test"]')).toBe("by_email");
    expect(streamOfBucket("m12|0[]")).toBe("m12");
  });
});

describe("rowsFromOps", () => {
  const op = (bucket: string, id: string, data: Record<string, unknown> | null) => ({ bucket, row_type: "Inspection", row_id: id, data: data && JSON.stringify(data) });

  it("drops removed rows, merges a row sent by two streams, and keeps which stream sent which column", () => {
    const rows = rowsFromOps([
      op('3#viewer|1["t"]', "a", { id: "a", title: "x" }),
      op('3#m7|0["t"]', "a", { id: "a", title: "x", internalNotes: "secret" }),
      op('3#viewer|1["t"]', "gone", null),
    ]);
    expect(rows).toEqual([
      {
        table: "Inspection",
        id: "a",
        data: { id: "a", title: "x", internalNotes: "secret" },
        sources: [
          { stream: "viewer", columns: ["id", "title"] },
          { stream: "m7", columns: ["id", "title", "internalNotes"] },
        ],
      },
    ]);
    const model: TableModel[] = [{ ...table("Inspection"), columns: [column({ name: "id", type: "uuid" })] }];
    const [hidden] = compare(rows, new Map([[rowKey("Inspection", "a"), { id: "a", title: "x", internalNotes: "secret" }]]), new Map([["Inspection", ["internalNotes"]]]), model);
    expect(hidden).toMatchObject({ kind: "hidden", streams: ["m7"], columns: ["internalNotes"] });
  });
});
