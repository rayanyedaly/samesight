import { describe, expect, it } from "vitest";
import type { DeviceRow } from "../differential/device.ts";
import type { ColumnModel, TableModel } from "../differential/model.ts";
import type { Run } from "../differential/run.ts";
import { type Exposure, exposureFindings, exposureScope, exposureTitle, noteExposure } from "./exposure.ts";

const column = (name: string, type = "text", comment?: string): ColumnModel => ({ name, type, nullable: true, hasDefault: false, computed: false, hints: [], ...(comment ? { comment } : {}) });

/** A table with an id key and, when `owner` names one, that column as its key to auth.users. */
function table(name: string, columns: ColumnModel[], owner?: string): TableModel {
  return {
    name,
    primaryKey: ["id"],
    unique: ["id"],
    columns: [column("id", "uuid"), ...columns],
    foreignKeys: owner ? [{ columns: [owner], schema: "auth", table: "users", references: ["id"] }] : [],
  };
}

const MEMBERS = table("members", [column("user_id", "uuid"), column("email"), column("full_name"), column("role"), column("is_admin", "boolean")], "user_id");
const NOTES = table("notes", [column("owner_id", "uuid"), column("chief_complaint", "text", "Why the patient came. samesight:personal=health"), column("email", "text", "A shared inbox. samesight:not-personal")], "owner_id");
const ORGS = table("orgs", [column("name"), column("billing_email")]);
const LISTS = table("lists", [column("owner_id", "uuid"), column("name")], "owner_id");

const run = { fixed: { users: [{ id: "a", label: "u0 (role=admin)" }, { id: "b", label: "u1" }, { id: "c", label: "u2" }] } } as unknown as Run;

const row = (table: string, data: Record<string, unknown>, stream = "org_members", columns = Object.keys(data)): DeviceRow => ({ table, id: String(data.id), data, sources: [{ stream, columns }] });

describe("exposureScope", () => {
  it("keeps each synced table's likely personal columns and its user's column", () => {
    const ex = exposureScope([MEMBERS, NOTES, ORGS, LISTS], ["members", "notes", "orgs", "lists"]);
    expect(ex.tables.map((t) => [t.table, t.owner, [...t.columns].map(([c, m]) => `${c}:${m.category}:${m.source}`)])).toEqual([
      ["members", "user_id", ["email:contact:name", "full_name:identifier:name"]],
      // A comment marker decides, either way.
      ["notes", "owner_id", ["chief_complaint:health:comment"]],
    ]);
    // No column for a user: not measured, and said so. A table with nothing personal is left out.
    expect(ex.unowned).toEqual([{ table: "orgs", columns: ["billing_email"] }]);
  });

  it("leaves out tables the run does not sync", () => {
    expect(exposureScope([MEMBERS], ["lists"]).tables).toEqual([]);
  });
});

describe("noteExposure", () => {
  const scoped = (): Exposure => exposureScope([MEMBERS, NOTES], ["members", "notes"]);

  it("counts the likely personal values a device holds of other run users' rows, by stream", () => {
    const ex = scoped();
    const devices = new Map([
      [
        "a",
        [
          row("members", { id: "m1", user_id: "b", email: "b@x", full_name: "B", role: "member" }),
          row("members", { id: "m2", user_id: "c", email: "c@x", full_name: null, role: "member" }),
          // The reader's own row, and a row of no run user's.
          row("members", { id: "m3", user_id: "a", email: "a@x", full_name: "A" }),
          row("members", { id: "m4", user_id: "zz", email: "z@x" }),
          // No owner value, and an owner column the stream did not send.
          row("members", { id: "m5", user_id: null, email: "n@x" }),
          row("members", { id: "m6", email: "e@x" }),
          // A stream that sent no personal column, and one that sent only a null.
          row("members", { id: "m7", user_id: "b", role: "member" }, "roles"),
          row("notes", { id: "n1", owner_id: "c", chief_complaint: null }, "notes"),
        ],
      ],
      ["b", [row("notes", { id: "n2", owner_id: "a", chief_complaint: "headache" }, "notes")]],
    ]);
    noteExposure(run, ex, devices);
    expect([...ex.held.values()].map((h) => [h.reader, h.table, h.stream, [...h.columns], [...h.owners], h.rows])).toEqual([
      ["u0", "members", "org_members", ["email", "full_name"], ["b", "c"], 2],
      ["u1", "notes", "notes", ["chief_complaint"], ["a"], 1],
    ]);
    expect(ex.datasets).toBe(1);
  });

  it("keeps each stream that sent a row apart, and adds datasets up", () => {
    const ex = scoped();
    const both: DeviceRow = { table: "members", id: "m1", data: { id: "m1", user_id: "b", email: "b@x", full_name: "B" }, sources: [{ stream: "org", columns: ["id", "user_id", "email"] }, { stream: "directory", columns: ["id", "user_id", "full_name"] }] };
    noteExposure(run, ex, new Map([["a", [both]]]));
    noteExposure(run, ex, new Map([["a", [both]]]));
    expect([...ex.held.values()].map((h) => [h.stream, [...h.columns], h.rows])).toEqual([
      ["org", ["email"], 2],
      ["directory", ["full_name"], 2],
    ]);
    expect(ex.datasets).toBe(2);
  });
});

describe("exposureFindings", () => {
  it("names each reader, table and stream with the columns and categories held, all ok", () => {
    const ex = exposureScope([MEMBERS, NOTES, ORGS], ["members", "notes", "orgs"]);
    noteExposure(
      run,
      ex,
      new Map([
        ["b", [row("notes", { id: "n2", owner_id: "a", chief_complaint: "headache" }, "notes")]],
        ["a", [row("members", { id: "m1", user_id: "b", email: "b@x", full_name: "B" }), row("members", { id: "m2", user_id: "c", email: "c@x" })]],
      ]),
    );
    expect(exposureFindings(ex)).toEqual([
      { status: "ok", check: "exposure", detail: "u0's device held email [contact], full_name [identifier] of 2 other run users' members rows, sent by stream org_members (2 rows over 1 dataset)" },
      { status: "ok", check: "exposure", detail: "u1's device held chief_complaint [health, marked in its comment] of 1 other run user's notes rows, sent by stream notes (1 row over 1 dataset)" },
      { status: "ok", check: "exposure", detail: "orgs: billing_email likely personal, but no column of it references auth.users, so whose rows reach whom is not read here" },
    ]);
  });

  it("says when nothing reached another user's device, or nothing could be measured", () => {
    const quiet = exposureScope([MEMBERS], ["members"]);
    noteExposure(run, quiet, new Map());
    expect(exposureFindings(quiet).map((f) => f.detail)).toEqual(["no likely personal column of one run user's rows reached another run user's device"]);
    expect(exposureFindings(exposureScope([ORGS], ["orgs"])).map((f) => f.detail)).toEqual([
      "no synced table with a likely personal column has a column for its user, so none was measured",
      "orgs: billing_email likely personal, but no column of it references auth.users, so whose rows reach whom is not read here",
    ]);
    expect(exposureFindings(exposureScope([LISTS], ["lists"])).map((f) => f.detail)).toEqual(["no synced table has a column that looks personal, by its name or a comment marker"]);
  });
});

describe("exposureTitle", () => {
  it("says how many datasets it covers when a failure or the time limit cut the run short", () => {
    const ex = exposureScope([MEMBERS], ["members"]);
    ex.datasets = 3;
    expect(exposureTitle(ex, { findings: [] })).toBe("Exposure (columns that likely hold personal data, by name or comment marker, of other run users' rows)");
    expect(exposureTitle(ex, { findings: [{ status: "fail", check: "differential", detail: "x" }] })).toBe("Exposure in the 3 datasets run before the failure");
    expect(exposureTitle(ex, { findings: [], stopped: true })).toBe("Exposure in the 3 datasets run before the time limit");
  });
});
