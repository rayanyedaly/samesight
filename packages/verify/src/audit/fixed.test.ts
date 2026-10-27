import { describe, expect, it } from "vitest";
import type { ColumnModel, TableModel } from "../differential/model.ts";
import { deleteRows } from "../differential/world.ts";
import { assignClaims } from "./assign.ts";
import { planClaims } from "./claims.ts";
import { dimLabel, fixedPlan, fixedRows, hookDims, userColumn } from "./fixed.ts";
import { hookKeysHeld } from "./run.ts";

const col = (name: string, type: string, more: Partial<ColumnModel> = {}): ColumnModel => ({ name, type, nullable: false, hasDefault: false, computed: false, hints: [], ...more });
const toUsers = (column: string) => ({ columns: [column], schema: "auth", table: "users", references: ["id"] });
const to = (column: string, table: string) => ({ columns: [column], schema: "public", table, references: ["id"] });

const teams: TableModel = { name: "teams", primaryKey: ["id"], unique: ["id"], columns: [col("id", "uuid"), col("name", "text")], foreignKeys: [] };
const memberships: TableModel = {
  name: "memberships",
  primaryKey: ["id"],
  unique: ["id", "user_id"],
  columns: [col("id", "uuid"), col("user_id", "uuid"), col("team_id", "uuid"), col("role", "text", { values: ["lead", "member"] }), col("note", "text", { nullable: true })],
  foreignKeys: [toUsers("user_id"), to("team_id", "teams")],
};
const audits: TableModel = { name: "audits", primaryKey: ["id"], unique: ["id"], columns: [col("id", "uuid"), col("at", "text")], foreignKeys: [] };
// Children before parents, as a catalog may list them: fixed rows still go in parents first.
const model = [memberships, teams, audits];
const body = "select team_id, role into m from public.memberships where user_id = (event->>'user_id')::uuid";

describe("fixedPlan", () => {
  it("gives rows to the hook's tables with a user column and to the tables they point at, and notes the others", () => {
    expect(fixedPlan(model, ["memberships", "audits"])).toEqual({
      tables: ["teams", "memberships"],
      perUser: ["memberships"],
      notes: ["the access token hook reads audits, which has no column pointing at auth.users, so audit does not choose its rows"],
    });
  });

  it("takes a table keyed by its user column (user_roles), and refuses what it could not find again or fill", () => {
    const userRoles: TableModel = { name: "user_roles", primaryKey: ["user_id"], unique: ["user_id"], columns: [col("user_id", "uuid"), col("role", "text")], foreignKeys: [toUsers("user_id")] };
    expect(fixedPlan([userRoles], ["user_roles"])).toMatchObject({ tables: ["user_roles"], perUser: ["user_roles"] });
    const counted: TableModel = { ...teams, name: "codes", primaryKey: ["code"], columns: [col("code", "text")] };
    const pointing: TableModel = { ...memberships, foreignKeys: [toUsers("user_id"), to("team_id", "codes")] };
    expect(fixedPlan([counted, pointing], ["memberships"]).refusal).toBe("codes has no uuid key of its own, so audit could not find its rows again");
    const elsewhere: TableModel = { ...memberships, foreignKeys: [toUsers("user_id"), { columns: ["team_id"], schema: "private", table: "teams", references: ["id"] }] };
    expect(fixedPlan([elsewhere], ["memberships"]).refusal).toBe("memberships.team_id must point at private.teams, where audit gives no rows");
    const odd: TableModel = { ...memberships, foreignKeys: [toUsers("user_id")], columns: [...memberships.columns, col("shape", "geometry")] };
    expect(fixedPlan([teams, odd], ["memberships"]).refusal).toBe("memberships.shape (geometry) needs a value audit cannot make");
  });
});

describe("hookDims and fixedRows", () => {
  const plan = fixedPlan(model, ["memberships"]);

  it("varies a per-user row over the rows its key points at and its CHECK list", () => {
    const dims = hookDims(model, plan, body, body);
    expect(dims).toEqual([
      { table: "memberships", column: "team_id", options: [0, 1], parent: "teams" },
      { table: "memberships", column: "role", options: ["lead", "member"] },
    ]);
    expect(dims.map((d) => dimLabel(d, d.options[1]))).toEqual(["memberships.team_id=teams row 2", "memberships.role='member'"]);
  });

  it("counts a column a function the hook calls names as read (planHook passes their bodies together)", () => {
    const helper = "select role from public.memberships where user_id = u";
    expect(hookDims(model, plan, "select public.role_of((event->>'user_id')::uuid)", "select public.role_of((event->>'user_id')::uuid)").map((d) => d.column)).toEqual(["team_id"]);
    expect(hookDims(model, plan, `select public.role_of((event->>'user_id')::uuid)\n;\n${helper}`, "select public.role_of((event->>'user_id')::uuid)").map((d) => d.column)).toEqual(["team_id", "role"]);
  });

  it("takes a column's literals only when the hook names it, and varies a table with nothing else by a row or none", () => {
    const flags: TableModel = { name: "flags", primaryKey: ["id"], unique: ["id"], columns: [col("id", "uuid"), col("user_id", "uuid"), col("tier", "text", { hints: ["gold"] })], foreignKeys: [toUsers("user_id")] };
    const p = fixedPlan([flags], ["flags"]);
    expect(hookDims([flags], p, "select tier from public.flags", "select tier from public.flags")).toEqual([{ table: "flags", column: "tier", options: ["gold"] }]);
    expect(hookDims([flags], p, "select 1 from public.flags", "select 1 from public.flags")).toEqual([{ table: "flags", column: null, options: [true, false] }]);
  });

  it("makes parent rows first, then a row per user with picks, pointing at them", () => {
    const dims = hookDims(model, plan, body, body);
    let n = 0;
    const mint = () => `5a3e5a3e-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    const rows = fixedRows(model, plan, dims, [[1, 0], [0, 1], undefined], ["u0-id", "u1-id", "u2-id"], mint);
    expect(rows.map((r) => [r.table, r.user])).toEqual([
      ["teams", undefined],
      ["teams", undefined],
      ["memberships", 0],
      ["memberships", 1],
    ]);
    const [a, b, m0, m1] = rows;
    expect(m0?.row).toMatchObject({ user_id: "u0-id", team_id: b?.row.id, role: "lead" });
    expect(m1?.row).toMatchObject({ user_id: "u1-id", team_id: a?.row.id, role: "member" });
    // Required columns are filled; a nullable one is left alone.
    expect(typeof a?.row.name).toBe("string");
    expect(m0?.row).not.toHaveProperty("note");
  });
});

describe("fixed rows across keys", () => {
  let n = 0;
  const mint = () => `5a3e5a3e-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  it("points every key to auth.users at run users, and a per-user row at the same user's row in another per-user table", () => {
    const owned: TableModel = { ...teams, columns: [...teams.columns, col("created_by", "uuid"), col("parent_id", "uuid", { nullable: true })], foreignKeys: [toUsers("created_by"), to("parent_id", "teams")] };
    const grants: TableModel = {
      name: "grants",
      primaryKey: ["id"],
      unique: ["id"],
      columns: [col("id", "uuid"), col("user_id", "uuid"), col("membership_id", "uuid"), col("granted_by", "uuid")],
      foreignKeys: [toUsers("user_id"), toUsers("granted_by"), to("membership_id", "memberships")],
    };
    const m = [owned, memberships, grants];
    const plan = fixedPlan(m, ["memberships", "grants"]);
    expect(plan).toMatchObject({ tables: ["teams", "memberships", "grants"], perUser: ["memberships", "grants"] });
    const dims = hookDims(m, plan, "select team_id, role, membership_id from memberships join grants using (user_id)", "select team_id, role, membership_id from memberships join grants using (user_id)");
    // No dim for the self-key on teams, or for grants.membership_id (the user's own membership).
    expect(dims.map((d) => `${d.table}.${d.column}`)).toEqual(["memberships.team_id", "memberships.role", "grants.null"]);
    const rows = fixedRows(m, plan, dims, [[0, 0, 0], [1, 1, 1], [0, 1, 0]], ["u0-id", "u1-id", "u2-id"], mint);
    const teamRows = rows.filter((r) => r.table === "teams");
    expect(teamRows.map((r) => [r.row.created_by, r.row.parent_id])).toEqual([
      ["u0-id", undefined],
      ["u1-id", undefined],
    ]);
    const ms = rows.filter((r) => r.table === "memberships");
    const gs = rows.filter((r) => r.table === "grants");
    // Users 0 and 2 have grants (the presence dim's option 0), each on their own membership, granted by themselves.
    expect(gs.map((g) => [g.user, g.row.membership_id === ms.find((x) => x.user === g.user)?.row.id, g.row.granted_by])).toEqual([
      [0, true, "u0-id"],
      [2, true, "u2-id"],
    ]);
  });

  it("leaves a table a hook row may point at with null generated, and refuses tables that point at each other", () => {
    const loose: TableModel = { ...memberships, columns: memberships.columns.map((c) => (c.name === "team_id" ? { ...c, nullable: true } : c)) };
    expect(fixedPlan([teams, loose], ["memberships"])).toMatchObject({ tables: ["memberships"], perUser: ["memberships"] });
    const circular: TableModel = { ...teams, columns: [...teams.columns, col("lead_id", "uuid")], foreignKeys: [to("lead_id", "memberships")] };
    expect(fixedPlan([circular, memberships], ["memberships"]).refusal).toMatch(/point at each other in a cycle$/);
  });

  it("varies a CHECK list only when the hook reads the column, and gives parent rows the values run users hold in a claim", () => {
    const plan = fixedPlan(model, ["memberships"]);
    expect(hookDims(model, plan, "select team_id from public.memberships", "select team_id from public.memberships").map((d) => d.column)).toEqual(["team_id"]);
    expect(hookDims(model, plan, "select m.* from public.memberships m", "select m.* from public.memberships m").map((d) => d.column)).toEqual(["team_id", "role"]);
    // A helper's select * reads its own table, not every column of the hook's.
    expect(hookDims(model, plan, "select team_id from public.memberships\n;\nselect * from settings", "select team_id from public.memberships").map((d) => d.column)).toEqual(["team_id"]);
    // A helper's select * from a per-user table reads every column of it.
    expect(hookDims(model, plan, "select public.team_of(u)\n;\nselect * from public.memberships", "select public.team_of(u)", ["memberships"]).map((d) => d.column)).toEqual(["team_id", "role"]);
    const rows = fixedRows(model, plan, [], [], [], mint, undefined, undefined, (t) => (t === "teams" ? new Map([["name", ["red", "blue"]]]) : undefined));
    expect(rows.map((r) => r.row.name)).toEqual(["red", "blue"]);
  });
});

describe("assignClaims with the hook's dims", () => {
  const read = (key: string) => `(auth.jwt() -> 'app_metadata'::text) ->> '${key}'::text`;
  const plan = planClaims([{ where: 'policy "p" on docs (USING)', sql: `(${read("role")}) = 'admin'::text`, dialect: "postgres", table: "docs" }]);
  const dims = hookDims(model, fixedPlan(model, ["memberships"]), body, body);

  it("picks metadata and hook rows together, with a copy of the first user and one with nothing", () => {
    const a = assignClaims(plan, () => "fresh", [], [], dims);
    // 2 roles x 2 teams x 2 roles in the hook: 8 combinations over 6 spread users.
    expect(a.users).toHaveLength(8);
    expect(a.hookPicks).toHaveLength(8);
    expect(a.hookPicks[6]).toEqual(a.hookPicks[0]);
    expect(a.hookPicks[7]).toBeUndefined();
    expect(new Set(a.hookPicks.slice(0, 6).map((p) => p?.[0]))).toEqual(new Set([0, 1]));
    expect(new Set(a.hookPicks.slice(0, 6).map((p) => p?.[1]))).toEqual(new Set([0, 1]));
    expect(a.partial).toBe(true);
    expect(a.findings).toContainEqual(expect.objectContaining({ detail: expect.stringMatching(/^8 combinations of claim values and access token hook rows, and 8 users hold 6 of them/) }));
  });

  it("gives a column compared with a hook claim the values the hook can add, never a key or the hook's own table", () => {
    const docs: TableModel = {
      name: "documents",
      primaryKey: ["id"],
      unique: ["id"],
      columns: [col("id", "uuid"), col("required_role", "text"), col("level", "integer")],
      foreignKeys: [],
    };
    const rule = (sql: string, table: string) => ({ where: `policy on ${table}`, sql, dialect: "postgres" as const, table });
    const hookPlan = planClaims([
      rule("(required_role = (auth.jwt() ->> 'team_role'::text))", "documents"),
      rule("((auth.jwt() ->> 'team_role'::text) = 'lead'::text)", "documents"),
      rule("(role = (auth.jwt() ->> 'team_role'::text))", "memberships"),
      rule("(id = ((auth.jwt() ->> 'team_id'::text))::uuid)", "documents"),
    ]);
    const a = assignClaims(hookPlan, () => "fresh", [...model, docs], [], dims);
    expect(a.claimValues.get("documents")?.get("required_role")).toEqual(["lead", "member"]);
    expect(a.claimValues.get("documents")?.has("id")).toBe(false);
    expect(a.claimValues.get("memberships")).toBeUndefined();
  });

  it("names a hook row no user holds", () => {
    const wide = [{ table: "memberships", column: "role", options: ["a", "b", "c", "d", "e", "f", "g", "h"] }];
    const a = assignClaims(planClaims([]), () => "fresh", [], [], wide);
    expect(a.findings).toContainEqual(expect.objectContaining({ detail: "8 users cannot hold every value: no user holds memberships.role='g' (an access token hook row), memberships.role='h' (an access token hook row)" }));
  });
});

describe("deleteRows on a table found by its user column alone", () => {
  it("deletes by owner when the table has no single key", async () => {
    const sql: [string, unknown[]][] = [];
    const client = { query: async (text: string, values: unknown[] = []) => sql.push([text, values]) } as never;
    const roles: TableModel = { name: "user_roles", primaryKey: ["user_id", "role"], unique: [], columns: [col("user_id", "uuid"), col("role", "text")], foreignKeys: [toUsers("user_id")] };
    await deleteRows(client, [roles, memberships], "5a3e5a3e", ["u0"]);
    expect(sql.filter(([t]) => t.startsWith("delete"))).toEqual([
      ['delete from public.memberships where id::text like $1 or user_id = any($2::uuid[])', ["5a3e5a3e%", ["u0"]]],
      ['delete from public.user_roles where user_id = any($1::uuid[])', [["u0"]]],
    ]);
  });

  it("takes a table keyed by team and user with an optional inviter, by its required user column", async () => {
    const members: TableModel = {
      name: "team_members",
      primaryKey: ["team_id", "user_id"],
      unique: [],
      columns: [col("team_id", "uuid"), col("user_id", "uuid"), col("invited_by", "uuid", { nullable: true })],
      foreignKeys: [toUsers("invited_by"), toUsers("user_id"), to("team_id", "teams")],
    };
    expect(fixedPlan([teams, members], ["team_members"])).toMatchObject({ tables: ["teams", "team_members"], perUser: ["team_members"] });
    // Keys come in constraint-name order (invited_by first): the user column is the required one.
    expect(userColumn(members)).toBe("user_id");
    const sql: [string, unknown[]][] = [];
    await deleteRows({ query: async (text: string, values: unknown[] = []) => sql.push([text, values]) } as never, [members], "5a3e5a3e", ["u0"]);
    expect(sql.filter(([t]) => t.startsWith("delete"))).toEqual([['delete from public.team_members where invited_by = any($1::uuid[]) or user_id = any($1::uuid[])', [["u0"]]]]);
    const rows = fixedRows([teams, members], fixedPlan([teams, members], ["team_members"]), [], [[]], ["u0-id"], () => "5a3e5a3e-k");
    expect(rows.find((r) => r.table === "team_members")?.row).toMatchObject({ user_id: "u0-id", invited_by: "u0-id" });
  });

  it("still refuses a table without a single key whose owner column may be null: such rows would never be found", async () => {
    const client = { query: async () => ({ rows: [] }) } as never;
    const links: TableModel = { name: "links", primaryKey: ["a_id", "b_id"], unique: [], columns: [col("a_id", "uuid"), col("b_id", "uuid"), col("created_by", "uuid", { nullable: true })], foreignKeys: [toUsers("created_by")] };
    await expect(deleteRows(client, [links], "5a3e5a3e", ["u0"])).rejects.toThrow(/cannot tell the run's rows of links apart/);
    expect(fixedPlan([links], ["links"]).refusal).toBe("links has no uuid key or required column pointing at auth.users of its own, so audit could not find its rows again");
  });
});

describe("hookKeysHeld", () => {
  it("counts a hook claim as held when every value the rules compare it with is held, and another", () => {
    const plan = planClaims([{ where: 'policy "p" on docs (USING)', sql: "((auth.jwt() ->> 'team_role'::text) = 'lead'::text)", dialect: "postgres", table: "docs" }]);
    const tokens = (...roles: (string | undefined)[]) => new Map(roles.map((r, i) => [`u${i}`, r === undefined ? {} : { team_role: r }]));
    expect(hookKeysHeld(plan, tokens("lead", "member", undefined))).toEqual(["team_role"]);
    expect(hookKeysHeld(plan, tokens("lead", undefined))).toEqual(["team_role"]);
    // Every lead row refused: member and none are two values, but no one holds the one the rule needs.
    expect(hookKeysHeld(plan, tokens("member", undefined))).toEqual([]);
    expect(hookKeysHeld(plan, tokens("lead", "lead"))).toEqual([]);
  });
});
