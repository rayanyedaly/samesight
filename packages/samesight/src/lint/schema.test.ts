import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Schema, schemaErrors, unsupported } from "../testing/json-schema.ts";
import type { LintFinding } from "./finding.ts";
import { lintDocument } from "./json.ts";

const schema = JSON.parse(readFileSync(new URL("../../schema/lint.schema.json", import.meta.url), "utf8")) as Schema;

const leak: LintFinding = { rule: "unscoped-query", level: "error", file: "sync-config.yaml", line: 8, column: 9, message: "queries[0] reads lists with no filter", subjects: ["user_data", "lists"] };
const note: LintFinding = { rule: "not-auto-subscribed", level: "info", file: "sync-config.yaml", message: "stream mine is not auto-subscribed" };
const doc = (o: Parameters<typeof lintDocument>[1]) => JSON.parse(JSON.stringify(lintDocument("0.1.0", o)));
const run = { files: ["sync-config.yaml"], rlsChecked: true, kept: [] as LintFinding[], allowed: [] as LintFinding[], unreadable: [] as { file: string; error: string }[], code: 0 as const };

describe("the lint schema", () => {
  it("uses only the keywords the test's validator supports", () => {
    expect(unsupported(schema)).toEqual([]);
  });

  it("takes the document for each exit, and for a run that could not start", () => {
    const docs = [
      doc(run),
      doc({ ...run, kept: [leak, note], allowed: [{ ...leak, line: 12 }], code: 1 }),
      doc({ ...run, files: ["sync-config.yaml", "bad.yaml"], rlsChecked: false, unreadable: [{ file: "bad.yaml", error: "the sync config has no streams: section" }], code: 2 }),
      doc({ error: "no sync config found (tried sync-config.yaml); name one: samesight lint <file>" }),
    ];
    for (const d of docs) expect(schemaErrors(schema, d), JSON.stringify(d)).toEqual([]);
    expect(docs.map((d) => [d.exitCode, d.errors, d.notes, d.error])).toEqual([
      [0, 0, 0, undefined],
      [1, 1, 1, undefined],
      [2, 0, 0, undefined],
      [2, 0, 0, "no sync config found (tried sync-config.yaml); name one: samesight lint <file>"],
    ]);
    expect(docs[0]?.$schema).toBe("https://unpkg.com/samesight@0.1.0/schema/lint.schema.json");
  });

  it("refuses a document that does not keep to it", () => {
    const good = doc({ ...run, kept: [leak], code: 1 });
    expect(schemaErrors(schema, { ...good, extra: true })).toEqual(["$: has extra"]);
    expect(schemaErrors(schema, { ...good, version: 2 })).toEqual(["$.version: not 1"]);
    expect(schemaErrors(schema, { ...good, exitCode: 3 })).toEqual(["$.exitCode: not one of [0,1,2]"]);
    expect(schemaErrors(schema, { ...good, findings: [{ ...leak, level: "fatal" }] })).toEqual(['$.findings[0].level: not one of ["error","warning","info"]']);
    expect(schemaErrors(schema, { ...good, findings: [{ ...leak, line: 0 }] })).toEqual(["$.findings[0].line: below 1"]);
    const { rlsChecked: _, ...short } = good;
    expect(schemaErrors(schema, short)).toEqual(["$: lacks rlsChecked"]);
  });

  it("puts only the finding's own fields in the document", () => {
    const extra = { ...leak, internal: "x" } as LintFinding;
    expect(Object.keys(doc({ ...run, kept: [extra], code: 1 }).findings[0])).toEqual(["rule", "level", "file", "line", "column", "message", "subjects"]);
  });
});
