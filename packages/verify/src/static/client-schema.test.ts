import { describe, expect, it } from "vitest";
import { ir, read } from "../fixtures/fieldbook.ts";
import { checkClientSchema } from "./client-schema.ts";

const source = read("src/lib/powersync/schema.ts");
/** Replaces exactly one occurrence, so a test cannot pass by matching nothing. */
function edit(from: string, to: string): string {
  const at = source.indexOf(from);
  if (at === -1 || source.indexOf(from, at + 1) !== -1) throw new Error(`expected one "${from}"`);
  return source.slice(0, at) + to + source.slice(at + from.length);
}
const statuses = (s: string) => checkClientSchema(ir, "schema.ts", s).map((f) => `${f.status}: ${f.detail}`);

describe("checkClientSchema", () => {
  it("passes Fieldbook's generated schema", () => {
    expect(statuses(source)).toEqual(["ok: schema.ts covers all 6 synced tables"]);
  });

  it("fails a synced table missing from the Schema", () => {
    expect(statuses(edit("  Photo,\n  RejectedWrite", "  RejectedWrite"))).toEqual([
      "fail: schema.ts has no Photo table; its synced rows are invisible to the app",
    ]);
  });

  it("warns about a synced column the app cannot read", () => {
    expect(statuses(edit("  sha256: column.text,\n", ""))).toEqual([
      "ok: schema.ts covers all 6 synced tables",
      "warn: schema.ts: Photo lacks sha256, which sync but the app cannot read",
    ]);
  });

  it("fails a file with no Schema", () => {
    expect(statuses("export {}")).toEqual(["fail: schema.ts: no `new Schema({ ... })` found"]);
  });
});
