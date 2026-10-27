import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reportDocument, type Section } from "./json.ts";
import type { Finding, RowReport } from "./report.ts";

type Schema = { [k: string]: unknown };
const schema = JSON.parse(readFileSync(new URL("../schema/report.schema.json", import.meta.url), "utf8")) as Schema;

// A validator for the keywords the schema uses, and no others: the guard below fails if it uses one more.
const KEYWORDS = new Set(["$schema", "title", "description", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "$ref", "$defs", "minimum", "maximum"]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const is = (type: string, v: unknown) =>
  type === "object" ? isObject(v) : type === "array" ? Array.isArray(v) : type === "integer" ? Number.isInteger(v) : type === "null" ? v === null : typeof v === type;

/** Every subschema, with where it is. */
function* subschemas(s: Schema, at = "#"): Generator<[string, Schema]> {
  yield [at, s];
  for (const [k, v] of Object.entries((s.properties ?? {}) as Schema)) yield* subschemas(v as Schema, `${at}/properties/${k}`);
  for (const [k, v] of Object.entries((s.$defs ?? {}) as Schema)) yield* subschemas(v as Schema, `${at}/$defs/${k}`);
  if (isObject(s.items)) yield* subschemas(s.items, `${at}/items`);
  if (isObject(s.additionalProperties)) yield* subschemas(s.additionalProperties, `${at}/additionalProperties`);
}

function errors(s: Schema, v: unknown, at = "$"): string[] {
  const out: string[] = [];
  if (typeof s.$ref === "string") out.push(...errors(s.$ref.split("/").slice(1).reduce((x: Schema, k) => x[k] as Schema, schema), v, at));
  if (s.type !== undefined) {
    const types = [s.type].flat() as string[];
    if (!types.some((t) => is(t, v))) return [...out, `${at}: not ${types.join(" or ")}`];
  }
  if ("const" in s && !same(s.const, v)) out.push(`${at}: not ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) out.push(`${at}: not one of ${JSON.stringify(s.enum)}`);
  if (typeof s.minimum === "number" && typeof v === "number" && v < s.minimum) out.push(`${at}: below ${s.minimum}`);
  if (typeof s.maximum === "number" && typeof v === "number" && v > s.maximum) out.push(`${at}: above ${s.maximum}`);
  if (isObject(v)) {
    for (const k of (s.required ?? []) as string[]) if (!(k in v)) out.push(`${at}: lacks ${k}`);
    const props = (s.properties ?? {}) as Schema;
    for (const [k, x] of Object.entries(v)) {
      if (k in props) out.push(...errors(props[k] as Schema, x, `${at}.${k}`));
      else if (s.additionalProperties === false) out.push(`${at}: has ${k}`);
      else if (isObject(s.additionalProperties)) out.push(...errors(s.additionalProperties, x, `${at}.${k}`));
    }
  }
  if (Array.isArray(v) && isObject(s.items)) out.push(...v.flatMap((x, i) => errors(s.items as Schema, x, `${at}[${i}]`)));
  return out;
}

const doc = (exitCode: number, sections: Section[], more: { argv?: string[]; error?: string } = {}) =>
  JSON.parse(JSON.stringify(reportDocument({ toolVersion: "0.1.0", argv: more.argv ?? ["audit"], exitCode, durationMs: 1234.5, sections, ...(more.error ? { error: more.error } : {}) })));

const leak: RowReport = {
  kind: "leak",
  summary: "u1 received lists 5a3e5a3e-0000 (owner_id u0) (stream user_data); RLS returns no such row for this user.",
  user: { label: "u1", id: "5a3e5a3e-0001", role: null },
  table: "lists",
  id: "5a3e5a3e-0000",
  row: "lists 5a3e5a3e-0000 (owner_id u0)",
  sentBy: [{ stream: "user_data", query: "queries[0]", sql: "SELECT * FROM lists" }],
  policies: [
    { name: "owned lists", permissive: true, verdict: "refuses" },
    { name: "not archived", permissive: false, verdict: "allows" },
  ],
  fix: { query: "queries[0]", add: "WHERE owner_id = auth.user_id()", why: 'queries[0] has no owner_id filter, which policy "owned lists" has' },
};
const replay = "samesight-verify audit --project upstream --seed 1842";
const differential: Finding = { status: "fail", check: "differential", detail: "devices and RLS disagree", rows: [leak, { ...leak, kind: "gap", sentBy: [], policies: undefined, fix: undefined, policiesNote: "RLS refuses the row when read again" }], replay };

describe("the report schema", () => {
  it("uses only the keywords the test's validator supports", () => {
    for (const [at, s] of subschemas(schema)) {
      expect(Object.keys(s).filter((k) => !KEYWORDS.has(k)), at).toEqual([]);
      if (s.type !== undefined) expect(([s.type].flat() as string[]).filter((t) => !TYPES.has(t)), at).toEqual([]);
      if (s.$ref !== undefined) expect(s.$ref, at).toMatch(/^#\/\$defs\/\w+$/);
      if (s.additionalProperties !== undefined) expect(s.additionalProperties === false || isObject(s.additionalProperties), at).toBe(true);
    }
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it.each([
    ["a pass", 0, [{ title: "Static checks", findings: [{ status: "ok", check: "streams", detail: "fine" }, { status: "warn", check: "powersync version", detail: "no compose file" }] }]],
    ["a leak, with rows, policies and a fix", 1, [{ title: "Differential (3 users, 1 datasets)", findings: [differential] }]],
    ["an incomplete run", 2, [{ title: "Differential", findings: [{ status: "fail", check: "differential", detail: "no dataset was tested before the time limit", incomplete: true }] }]],
  ] as [string, number, Section[]][])("validates %s", (_, code, sections) => {
    const d = doc(code, sections, { argv: ["audit", "--seed", "7"] });
    expect(errors(schema, d)).toEqual([]);
    expect(d).toMatchObject({ version: 1, tool: "samesight-verify", mode: "audit", exitCode: code, result: ["passed", "failed", "incomplete"][code], seed: 7, durationMs: 1235 });
  });

  it("validates an error document, with its message and no sections", () => {
    const d = doc(2, [], { argv: ["--runs", "many"], error: '--runs must be a whole number of at least 1, not "many"' });
    expect(errors(schema, d)).toEqual([]);
    expect(d).toMatchObject({ mode: "policy", result: "incomplete", error: expect.stringMatching(/--runs/) });
    expect(d.seed).toBeUndefined();
  });

  it("takes the replay from the differential, and keeps only the fields the schema has", () => {
    const extra = { ...differential, rows: [{ ...leak, extra: 1, user: { ...leak.user, claims: {} } } as RowReport], other: true } as Finding;
    const d = doc(1, [{ title: "Differential", findings: [extra] }]);
    expect(d.replay).toBe(replay);
    expect(errors(schema, d)).toEqual([]);
    expect(d.sections[0].findings[0].rows[0].user).toEqual({ label: "u1", id: "5a3e5a3e-0001", role: null });
  });

  it("refuses what it should, so the passes above mean something", () => {
    const d = doc(1, [{ title: "Differential", findings: [differential] }]);
    expect(errors(schema, { ...d, exitCode: 3 })).toEqual(["$.exitCode: not one of [0,1,2]"]);
    d.sections[0].findings[0].rows[0].sentBy[0].extra = 1;
    delete d.sections[0].findings[0].rows[0].user.id;
    d.sections[0].findings[0].rows[0].policies[0].verdict = "maybe";
    expect(errors(schema, d)).toEqual([
      "$.sections[0].findings[0].rows[0].user: lacks id",
      "$.sections[0].findings[0].rows[0].sentBy[0]: has extra",
      '$.sections[0].findings[0].rows[0].policies[0].verdict: not one of ["allows","refuses"]',
    ]);
    expect(errors(schema, { ...d, durationMs: 1.5, tool: "other" })).toContain("$.durationMs: not integer");
  });
});
