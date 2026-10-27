/**
 * Audit on examples/audit-roles, an app whose RLS and sync streams read a role and an org
 * from app_metadata: pnpm --filter audit-roles stack:up first. PowerSync is auto-started
 * for the file, as audit does (Docker), and users are signed up once.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { parseSyncConfig } from "samesight/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { type AutoStarted, autoStart } from "../autostart/run.ts";
import { differential, PREFIX, type Run, setUpUsers, tearDown } from "../differential/run.ts";
import { readModel } from "../differential/model.ts";
import { prefixedUuid } from "../differential/world.ts";
import { readStack } from "../stack.ts";
import { metadataOf } from "./assign.ts";
import { checkAuditCatalog } from "./catalog.ts";
import type { Assignment } from "./assign.ts";
import { hookKeysHeld, planRun, type RunPlan } from "./run.ts";
import { claimFindings, type ClaimsPlan, planClaims, policyFunctions, policyRules, syncRules } from "./claims.ts";
import { coverageScope, stateOf } from "./coverage.ts";
import { SIGN_IN } from "./signin.ts";

const APP = fileURLToPath(new URL("../../../../examples/audit-roles/", import.meta.url));
const SYNCED = ["documents", "orgs"];

const CONFIG = readFileSync(`${APP}sync-config.yaml`, "utf8");

let client: pg.Client;
let own: pg.Client | undefined;
let started: AutoStarted | undefined;
let s: Run;
let plan: ClaimsPlan;
let assignment: Assignment;
let run: RunPlan;
beforeAll(async () => {
  let stack = readStack(APP, "http://127.0.0.1");
  client = await connectLocal(stack.db);
  own = await connectLocal(stack.db);
  started = await autoStart({
    projectDir: APP,
    client: own,
    dbPort: Number(new URL(stack.db).port),
    api: stack.api,
    ...(stack.jwtSecret ? { jwtSecret: stack.jwtSecret } : {}),
    syncConfig: CONFIG,
    tables: SYNCED,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  stack = { ...stack, powersync: started.url, slotPrefix: started.slotPrefix };
  // Planned as audit() plans it: the claims, the hook's rows, the values each user holds.
  run = await planRun(client, parseSyncConfig(CONFIG), APP);
  plan = run.claims;
  assignment = run.assignment;
  s = await setUpUsers(client, stack, run.setUp.scope, run.setUp.claims);
}, 180_000);
afterAll(async () => {
  let left: string[] = [];
  try {
    if (s) await tearDown(s);
  } finally {
    try {
      left = (await started?.stop()) ?? [];
    } finally {
      await own?.end();
      await client?.end();
    }
  }
  expect(left).toEqual([]);
});

describe("the roles app's catalog", () => {
  it("passes, with the restrictive policy listed as such", async () => {
    const findings = await checkAuditCatalog(client, SYNCED);
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    expect(findings).toContainEqual(expect.objectContaining({ check: "policies", detail: expect.stringContaining('"no archived" (SELECT to authenticated, restrictive)') }));
  });
});

const discover = async () => planClaims([...(await policyRules(client)), ...syncRules(parseSyncConfig(CONFIG))], await policyFunctions(client));

describe("claim discovery on the roles app", () => {
  it("finds the role and the org in app_metadata, the team and team role the hook adds, and nothing it cannot read", async () => {
    const plan = await discover();
    expect(plan.uses.map((u) => [u.key, u.cls])).toEqual([
      ["app_metadata.org_id", "app_metadata"],
      ["app_metadata.role", "app_metadata"],
      ["sub", "identity"],
      ["team_id", "hook"],
      ["team_role", "hook"],
    ]);
    const role = plan.uses.find((u) => u.key === "app_metadata.role");
    expect(role?.values).toEqual(["admin", "editor"]);
    expect(role?.rules).toEqual([
      'policy "admins read all" on documents (USING)',
      'policy "editors read published" on documents (USING)',
      'policy "admins read orgs" on orgs (USING)',
      "editor.queries[0]",
      "admin.queries[0]",
      "admin.queries[1]",
    ]);
    expect(plan.uses.find((u) => u.key === "app_metadata.org_id")).toMatchObject({ columns: ["org_id", "id"], casts: ["uuid"], values: [], other: [] });
    expect(plan.identityColumns).toEqual(["owner_id", "user_id"]);
    expect(plan.unreadable).toEqual([]);
  });
});


describe("run users holding the roles, the orgs and the hook's teams", () => {
  const tokensOf = () => new Map(s.fixed.users.map((u) => [u.label.split(" ")[0] as string, s.sessions.get(u.id)?.claims ?? {}]));

  it("plans the hook's rows: a membership per user but the last, over two teams and both roles", () => {
    expect(run.hookPlan).toMatchObject({ tables: ["memberships"], role: "supabase_auth_admin", steer: { perUser: ["memberships"] } });
    expect(run.hookPlan?.cannot).toBeUndefined();
    expect(run.setUp.scope.fixed?.tables).toEqual(["teams", "memberships"]);
    const rows = run.setUp.scope.fixed?.rows ?? [];
    expect(rows.filter((r) => r.table === "teams")).toHaveLength(2);
    expect(rows.filter((r) => r.table === "memberships").map((r) => r.user)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(s.fixedRefused).toEqual([]);
  });

  it("signs users up holding every role, org, team and team role, whose tokens carry them, the copy and the bare user as planned", () => {
    expect(assignment.paths.map((p) => [p.key, p.columns])).toEqual([
      ["app_metadata.org_id", ["orgs.id"]],
      ["app_metadata.role", []],
    ]);
    const tokens = tokensOf();
    expect(s.fixed.users).toHaveLength(8);
    // Each token carries the team and role of the membership audit gave its user.
    const rows = (run.setUp.scope.fixed?.rows ?? []).filter((r) => r.table === "memberships");
    for (const [i, u] of s.fixed.users.entries()) {
      const row = rows.find((r) => r.user === i)?.row;
      expect([tokens.get(`u${i}`)?.team_id ?? null, tokens.get(`u${i}`)?.team_role ?? null], u.label).toEqual([row ? row.team_id : null, row ? row.role : null]);
    }
    const held = (path: (t: Record<string, unknown>) => unknown) => new Set([...tokens.values()].map((t) => JSON.stringify(path(t) ?? null)));
    expect(held((t) => (t.app_metadata as Record<string, unknown>)?.role)).toEqual(new Set(['"admin"', '"editor"', '"samesight-other"', "null"]));
    expect(held((t) => t.team_role)).toEqual(new Set(['"lead"', '"member"', "null"]));
    expect(held((t) => t.team_id).size).toBe(3);
    expect(s.fixed.users[6]?.label.replace(/^u6/, "")).toBe(s.fixed.users[0]?.label.replace(/^u0/, ""));
    expect(s.fixed.users[7]?.label).toBe("u7");
    expect(s.fixed.users[0]?.label).toMatch(/team_id=teams row [12], team_role=(lead|member)\)$/);
    expect(hookKeysHeld(plan, tokens)).toEqual(["team_id", "team_role"]);
    // Only the joint picker's warning: 3 roles x 2 orgs x 2 teams x 2 team roles over 6 users.
    const lines = claimFindings(plan, run.hook, tokens, assignment, run.hookPlan);
    expect(lines.filter((f) => f.status !== "ok").map((f) => f.detail)).toEqual(["24 combinations of claim values and access token hook rows, and 8 users hold 6 of them; rules that need values together may not be tested"]);
    expect(lines.find((f) => f.detail.startsWith("team_role"))?.detail).toMatch(/from rows audit gives each run user in memberships before signing in; held: (lead|member) u0 /);
    expect(lines.find((f) => f.detail.startsWith("app_metadata.org_id"))?.detail).toMatch(/; generated rows take them in orgs\.id$/);
  });

  it("lets only supabase_auth_admin run the hook, as the migration says", async () => {
    const can = async (role: string) =>
      (await client.query<{ ok: boolean }>("select has_function_privilege($1, 'public.custom_access_token_hook(jsonb)', 'execute') as ok", [role])).rows[0]?.ok;
    expect([await can("anon"), await can("authenticated"), await can("service_role"), await can("supabase_auth_admin")]).toEqual([false, false, false, true]);
  });
});

describe("coverage on the roles app", () => {
  it("sees every policy and stream allowing and refusing a run user a row", async () => {
    const config = parseSyncConfig(CONFIG);
    const held = new Set([...assignment.paths.map((p) => p.key), ...hookKeysHeld(plan, new Map(s.fixed.users.map((u) => [u.id, s.sessions.get(u.id)?.claims ?? {}])))]);
    const cov = await coverageScope(client, SYNCED, config.streams, await policyFunctions(client), config.kind, held);
    const result = await differential(s, { runs: 8, seed: 5, timeLimitMs: 240_000, coverage: cov });
    expect(result.findings.filter((f) => f.status === "fail")).toEqual([]);
    expect(cov.policies.map((p) => [`${p.table}: ${p.name}`, stateOf(p.tally)]).filter(([, state]) => state !== "exercised")).toEqual([]);
    expect(cov.policies).toHaveLength(9);
    expect(cov.units.map((u) => [`${u.streams.join("+")} ${u.table}`, stateOf(u.tally)]).filter(([, state]) => state !== "exercised")).toEqual([]);
    expect(cov.units).toHaveLength(8);
    expect(cov.triggers).toEqual([]);
  }, 400_000);
});

describe("what Supabase Auth puts in run users' tokens about the sign-in", () => {
  it("matches the sign-in facts Claims and Coverage word from", () => {
    const tokens = s.fixed.users.map((u) => s.sessions.get(u.id)?.claims ?? {});
    const at = (claims: Record<string, unknown>, key: string) => key.split(".").reduce<unknown>((x, k) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), claims);
    for (const [key, f] of Object.entries(SIGN_IN)) {
      const values = tokens.map((c) => at(c, key));
      if (f.kind === "absent") expect(values.every((v) => v === undefined), key).toBe(true);
      else expect(values.every((v) => v !== undefined), key).toBe(true);
      // Equal for alike claims; for set ones (times), only present and of one type: two sign-ins can straddle a second.
      if (f.kind === "alike") expect(values.every((v) => JSON.stringify(v) === JSON.stringify(f.value)), key).toBe(true);
      if (f.kind === "set") expect(new Set(values.map((v) => typeof v)).size, key).toBe(1);
      if (f.kind === "own") expect(new Set(values.map((v) => JSON.stringify(v))).size, key).toBe(tokens.length);
    }
  });
});
