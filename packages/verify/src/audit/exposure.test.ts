import { describe, expect, it } from "vitest";
import type { DeviceRow } from "../differential/device.ts";
import type { ColumnModel, TableModel } from "../differential/model.ts";
import type { Run } from "../differential/run.ts";
import type { Inserted } from "../differential/world.ts";
import { type Exposure, exposureFindings, exposureScope, exposureTitle, noteExposure } from "./exposure.ts";

const column = (name: string, type = "text", comment?: string): ColumnModel => ({ name, type, nullable: true, hasDefault: false, computed: false, hints: [], ...(comment ? { comment } : {}) });

/** A table with an id key and, for each of `owners`, that column as a key to auth.users. */
function table(name: string, columns: ColumnModel[], ...owners: string[]): TableModel {
  return {
    name,
    primaryKey: ["id"],
    unique: ["id"],
    columns: [column("id", "uuid"), ...columns],
    foreignKeys: owners.map((o) => ({ columns: [o], schema: "auth", table: "users", references: ["id"] })),
  };
}

const MEMBERS = table("members", [column("user_id", "uuid"), column("email"), column("full_name"), column("role"), column("is_admin", "boolean")], "user_id");
const NOTES = table("notes", [column("owner_id", "uuid"), column("chief_complaint", "text", "Why the patient came. samesight:personal=health"), column("email", "text", "A shared inbox. samesight:not-personal")], "owner_id");
const ORGS = table("orgs", [column("name"), column("billing_email")]);
const LISTS = table("lists", [column("owner_id", "uuid"), column("name")], "owner_id");
const VISITS = table("visits", [column("doctor_id", "uuid"), column("patient_id", "uuid"), column("allergy", "boolean"), column("lat", "numeric"), column("lng", "numeric")], "doctor_id", "patient_id");
// Rows whose id the run cannot match: one from a sequence, one with no id column.
const LOGS = { ...table("logs", [column("user_id", "uuid"), column("email")], "user_id"), columns: [{ ...column("id", "bigint"), autoKey: true }, column("user_id", "uuid"), column("email")] };
const PINS = { ...table("pins", [column("user_id", "uuid"), column("email")], "user_id"), primaryKey: ["user_id"], columns: [column("user_id", "uuid"), column("email")] };
const MESSAGES = table("messages", [column("sender_id", "uuid"), column("recipient_id", "uuid"), column("recipient_phone")], "sender_id", "recipient_id");
// Keyed by its user, as the access token hook's per-user tables can be.
const PROFILES = table("profiles", [column("phone")], "id");

const run = { fixed: { users: [{ id: "a", label: "u0 (role=admin)" }, { id: "b", label: "u1" }, { id: "c", label: "u2" }] } } as unknown as Run;

const row = (table: string, data: Record<string, unknown>, stream = "org_members", columns = Object.keys(data)): DeviceRow => ({ table, id: String(data.id), data, sources: [{ stream, columns }] });
const ins = (table: string, row: Record<string, unknown>): Inserted => ({ table, row, tenant: null });

describe("exposureScope", () => {
  it("keeps each synced table's likely personal columns and its columns for a user", () => {
    const ex = exposureScope([MEMBERS, NOTES, ORGS, LISTS, MESSAGES], ["members", "notes", "orgs", "lists", "messages"]);
    expect(ex.tables.map((t) => [t.table, t.owners, [...t.columns].map(([c, m]) => `${c}:${m.category}:${m.source}`)])).toEqual([
      ["members", ["user_id"], ["email:contact:name", "full_name:identifier:name"]],
      // A comment marker decides, either way.
      ["notes", ["owner_id"], ["chief_complaint:health:comment"]],
      ["messages", ["sender_id", "recipient_id"], ["recipient_phone:contact:name"]],
    ]);
    // No column for a user: not measured, and said so. A table with nothing personal is left out.
    expect(ex.unowned).toEqual([{ table: "orgs", columns: ["billing_email"], why: "no column of it references auth.users" }]);
  });

  it("names tables whose rows the run cannot match by id as not measured", () => {
    expect(exposureFindings(exposureScope([PINS], ["pins"])).map((f) => f.detail)).toEqual([
      "no synced table with a likely personal column could be measured",
      "pins: email likely personal, but it has no id column to match its rows by, so whose rows reach whom is not read here",
    ]);
    expect(exposureScope([LOGS, PINS], ["logs", "pins"]).unowned).toEqual([
      { table: "logs", columns: ["email"], why: "the database sets its id, which the run does not read back" },
      { table: "pins", columns: ["email"], why: "it has no id column to match its rows by" },
    ]);
  });

  it("passes types and sibling names to the matcher, and never counts a user key as personal", () => {
    // allergy is a flag here, not data; lat counts beside lng; patient_id, a second key to a user, names whose row it is.
    const ex = exposureScope([VISITS], ["visits"]);
    expect(ex.tables.map((t) => [t.table, t.owners, [...t.columns.keys()]])).toEqual([["visits", ["doctor_id", "patient_id"], ["lat", "lng"]]]);
  });

  it("leaves out tables the run does not sync", () => {
    expect(exposureScope([MEMBERS], ["lists"]).tables).toEqual([]);
  });
});

describe("noteExposure", () => {
  const scoped = (): Exposure => exposureScope([MEMBERS, NOTES, MESSAGES, PROFILES], ["members", "notes", "messages", "profiles"]);
  const inserted = [
    ins("members", { id: "m1", user_id: "b" }),
    ins("members", { id: "m2", user_id: "c" }),
    ins("members", { id: "m3", user_id: "a" }),
    ins("members", { id: "m5", user_id: null }),
    ins("members", { id: "m7", user_id: "b" }),
    ins("notes", { id: "n1", owner_id: "c" }),
    ins("notes", { id: "n2", owner_id: "a" }),
    // A row of a table outside the scope, as the run passes every table's.
    ins("lists", { id: "l1", owner_id: "b" }),
  ];

  it("counts the likely personal values a device holds of other run users' rows, by stream", () => {
    const ex = scoped();
    const devices = new Map([
      [
        "a",
        [
          row("members", { id: "m1", user_id: "b", email: "b@x", full_name: "B", role: "member" }),
          // Whose a row is comes from the run's rows: a stream that leaves the user's column out still counts.
          row("members", { id: "m2", email: "c@x", full_name: null, role: "member" }),
          // The reader's own row, a row the run did not insert, and one with no user.
          row("members", { id: "m3", user_id: "a", email: "a@x", full_name: "A" }),
          row("members", { id: "m4", user_id: "b", email: "z@x" }),
          row("members", { id: "m5", user_id: null, email: "n@x" }),
          // A stream that sent no personal column, and one that sent only a null.
          row("members", { id: "m7", user_id: "b", role: "member" }, "roles"),
          row("notes", { id: "n1", owner_id: "c", chief_complaint: null }, "notes"),
        ],
      ],
      ["b", [row("notes", { id: "n2", owner_id: "a", chief_complaint: "headache" }, "notes")]],
    ]);
    noteExposure(run, ex, inserted, devices);
    expect(ex.unmatched).toEqual(new Set());
    expect([...ex.held.values()].map((h) => [h.reader, h.table, h.stream, [...h.columns], [...h.owners], h.rows.size])).toEqual([
      ["u0", "members", "org_members", ["email", "full_name"], ["b", "c"], 2],
      ["u1", "notes", "notes", ["chief_complaint"], ["a"], 1],
    ]);
    expect(ex.datasets).toBe(1);
  });

  it("counts a row against each of its users but the reader, and reads a table keyed by its user", () => {
    const ex = scoped();
    noteExposure(
      run,
      ex,
      [ins("messages", { id: "x1", sender_id: "a", recipient_id: "b" })],
      new Map([
        // A message is its sender's and its recipient's: each holds the other's share of it.
        ["b", [row("messages", { id: "x1", recipient_phone: "555" }, "inbox")]],
        ["a", [row("messages", { id: "x1", recipient_phone: "555" }, "outbox")]],
        // A third user holding it holds both users' row.
        ["c", [row("messages", { id: "x1", recipient_phone: "555" }, "everyone")]],
      ]),
    );
    expect([...ex.held.values()].map((h) => [h.reader, h.table, h.shared, [...h.owners]])).toEqual([
      ["u0", "messages", true, ["b"]],
      ["u1", "messages", true, ["a"]],
      ["u2", "messages", false, ["a", "b"]],
    ]);
    // A shared row's values may be the reader's own, so its line says the row is shared.
    expect(exposureFindings(ex).map((f) => f.detail)).toEqual([
      "u0's device held recipient_phone [contact] of messages rows u0 shares with 1 other run user, sent by stream outbox (1 row over 1 dataset)",
      "u1's device held recipient_phone [contact] of messages rows u1 shares with 1 other run user, sent by stream inbox (1 row over 1 dataset)",
      "u2's device held recipient_phone [contact] of 2 other run users' messages rows, sent by stream everyone (1 row over 1 dataset)",
    ]);
    // A profile keyed by its user is that user's row.
    const other = scoped();
    noteExposure(run, other, [ins("profiles", { id: "c" })], new Map([["a", [row("profiles", { id: "c", phone: "777" }, "everyone")]]]));
    expect([...other.held.values()].map((h) => [h.reader, h.table, [...h.owners]])).toEqual([["u0", "profiles", ["c"]]]);
  });

  it("names a table some of whose rows had no id the run set, and claims nothing about them", () => {
    const ex = scoped();
    noteExposure(run, ex, [ins("members", { user_id: "b" }), ins("members", { id: null, user_id: "c" })], new Map([["a", [row("members", { id: "m9", user_id: "b", email: "b@x" })]]]));
    expect(ex.held.size).toBe(0);
    expect(exposureFindings(ex).map((f) => f.detail)).toEqual([
      "in the rows it could match, no likely personal column of one run user's rows reached another run user's device",
      "members: some run rows had no id the run set (the database's default, or none), so those were not matched and are not counted here",
    ]);
  });

  it("keeps each stream that sent a row apart, and counts a row kept for every dataset once", () => {
    const ex = scoped();
    const kept = { ...run, fixedRows: [ins("members", { id: "m1", user_id: "b" })] } as unknown as Run;
    const both: DeviceRow = { table: "members", id: "m1", data: { id: "m1", user_id: "b", email: "b@x", full_name: "B" }, sources: [{ stream: "org", columns: ["id", "user_id", "email"] }, { stream: "directory", columns: ["id", "user_id", "full_name"] }] };
    noteExposure(kept, ex, [], new Map([["a", [both]]]));
    noteExposure(kept, ex, [], new Map([["a", [both]]]));
    expect([...ex.held.values()].map((h) => [h.stream, [...h.columns], h.rows.size])).toEqual([
      ["org", ["email"], 1],
      ["directory", ["full_name"], 1],
    ]);
    expect(ex.datasets).toBe(2);
  });

  it("counts a dataset's own rows in each dataset, though the next one takes the same id", () => {
    // A key a claim holds is the id of the first rows of every dataset, each a new row.
    const ex = scoped();
    for (const user of ["b", "c"]) noteExposure(run, ex, [ins("members", { id: "k1", user_id: user })], new Map([["a", [row("members", { id: "k1", email: `${user}@x` })]]]));
    expect([...ex.held.values()].map((h) => [h.reader, [...h.owners], h.rows.size])).toEqual([["u0", ["b", "c"], 2]]);
  });

  it("matches a device row only to the run's row of its own table", () => {
    const ex = scoped();
    noteExposure(run, ex, [ins("notes", { id: "x", owner_id: "b" }), ins("members", { id: "x", user_id: "a" })], new Map([["a", [row("members", { id: "x", user_id: "a", email: "a@x" })]]]));
    expect(ex.held.size).toBe(0);
  });
});

describe("exposureFindings", () => {
  it("names each reader, table and stream with the columns and categories held, all ok", () => {
    const ex = exposureScope([MEMBERS, NOTES, ORGS], ["members", "notes", "orgs"]);
    noteExposure(
      run,
      ex,
      [ins("notes", { id: "n2", owner_id: "a" }), ins("members", { id: "m1", user_id: "b" }), ins("members", { id: "m2", user_id: "c" })],
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

  it("lists only the columns a device held, in the run's order of users, then table and stream", () => {
    const users = Array.from({ length: 11 }, (_, n) => ({ id: `id${n}`, label: `u${n}` }));
    const many = { fixed: { users } } as unknown as Run;
    const ex = exposureScope([MEMBERS, NOTES], ["members", "notes"]);
    const own = (id: string, user: string) => ins("members", { id, user_id: user });
    noteExposure(
      many,
      ex,
      [own("m1", "id0"), ins("notes", { id: "n1", owner_id: "id0" })],
      new Map([
        ["id10", [row("members", { id: "m1", user_id: "id0", email: "e@x", full_name: "F" }, "org", ["id", "email"])]],
        ["id2", [row("notes", { id: "n1", chief_complaint: "x" }, "0-notes"), row("members", { id: "m1", email: "e@x" }, "b-stream"), row("members", { id: "m1", email: "e@x" }, "a-stream")]],
      ]),
    );
    expect(exposureFindings(ex).map((f) => f.detail)).toEqual([
      "u2's device held email [contact] of 1 other run user's members rows, sent by stream a-stream (1 row over 1 dataset)",
      "u2's device held email [contact] of 1 other run user's members rows, sent by stream b-stream (1 row over 1 dataset)",
      "u2's device held chief_complaint [health, marked in its comment] of 1 other run user's notes rows, sent by stream 0-notes (1 row over 1 dataset)",
      "u10's device held email [contact] of 1 other run user's members rows, sent by stream org (1 row over 1 dataset)",
    ]);
  });

  it("says when nothing reached another user's device, nothing was measured, or nothing could be", () => {
    const quiet = exposureScope([MEMBERS], ["members"]);
    noteExposure(run, quiet, [], new Map());
    expect(exposureFindings(quiet).map((f) => f.detail)).toEqual(["no likely personal column of one run user's rows reached another run user's device"]);
    // No dataset passed: claim nothing.
    expect(exposureFindings(exposureScope([MEMBERS], ["members"])).map((f) => f.detail)).toEqual(["no dataset passed before the run stopped, so nothing was measured"]);
    expect(exposureFindings(exposureScope([ORGS], ["orgs"])).map((f) => f.detail)).toEqual([
      "no synced table with a likely personal column could be measured",
      "orgs: billing_email likely personal, but no column of it references auth.users, so whose rows reach whom is not read here",
    ]);
    expect(exposureFindings(exposureScope([LISTS], ["lists"])).map((f) => f.detail)).toEqual(["no synced table has a column that looks personal, by its name or a comment marker"]);
    // A table measured beside one that is not: nothing reached, in the rows it could read.
    const some = exposureScope([MEMBERS, ORGS], ["members", "orgs"]);
    noteExposure(run, some, [], new Map());
    expect(exposureFindings(some)[0]?.detail).toBe("in the rows it could match, no likely personal column of one run user's rows reached another run user's device");
  });

  it("says a table's keys to auth.users look personal, rather than that nothing does", () => {
    // patient_id reads as an identifier, but it names whose the visit is: it is not someone else's data on the row.
    const CHARTS = table("charts", [column("doctor_id", "uuid"), column("patient_id", "uuid")], "doctor_id", "patient_id");
    const ex = exposureScope([CHARTS, LISTS], ["charts", "lists"]);
    expect(ex.keysOnly).toEqual(["charts"]);
    expect(exposureFindings(ex).map((f) => f.detail)).toEqual(["no synced table has a column that looks personal, by its name or a comment marker, apart from keys to auth.users, which say whose a row is (charts)"]);
  });
});

describe("exposureTitle", () => {
  it("says how many datasets it covers when a failure or the time limit cut the run short", () => {
    const ex = exposureScope([MEMBERS], ["members"]);
    const fail = { status: "fail", check: "differential", detail: "x" } as const;
    ex.datasets = 3;
    expect(exposureTitle(ex, { findings: [], runs: 3 })).toBe("Exposure (columns that likely hold personal data, by name or comment marker, of other run users' rows)");
    // The fourth dataset failed, so it was not measured.
    expect(exposureTitle(ex, { findings: [fail], runs: 4 })).toBe("Exposure in the 3 datasets run before the failure");
    // A run that broke down in its last dataset, measured or not.
    expect(exposureTitle(ex, { findings: [{ ...fail, incomplete: true }], runs: 3 })).toBe("Exposure in the 3 datasets run before the failure");
    expect(exposureTitle(ex, { findings: [], runs: 3, stopped: true })).toBe("Exposure in the 3 datasets run before the time limit");
    // Every dataset passed, and a failure about the run as a whole cut nothing short.
    expect(exposureTitle(ex, { findings: [fail], runs: 3 })).toBe("Exposure (columns that likely hold personal data, by name or comment marker, of other run users' rows)");
    ex.datasets = 1;
    expect(exposureTitle(ex, { findings: [fail], runs: 2 })).toBe("Exposure in the 1 dataset run before the failure");
    // The time limit came before the first dataset.
    ex.datasets = 0;
    expect(exposureTitle(ex, { findings: [{ ...fail, incomplete: true }], runs: 0 })).toBe("Exposure in the 0 datasets run before the time limit");
  });
});
