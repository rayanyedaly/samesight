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
import { prefixedUuid } from "../differential/world.ts";
import { readStack } from "../stack.ts";
import { metadataOf } from "./assign.ts";
import { checkAuditCatalog } from "./catalog.ts";
import { type Assignment, assignClaims as assign } from "./assign.ts";
import { claimFindings, type ClaimsPlan, planClaims, policyFunctions, policyRules, syncRules } from "./claims.ts";
import { coverageScope, stateOf } from "./coverage.ts";

const APP = fileURLToPath(new URL("../../../../examples/audit-roles/", import.meta.url));
const SYNCED = ["documents", "orgs"];

const CONFIG = readFileSync(`${APP}sync-config.yaml`, "utf8");

let client: pg.Client;
let own: pg.Client | undefined;
let started: AutoStarted | undefined;
let s: Run;
let plan: ClaimsPlan;
let assignment: Assignment;
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
  plan = await discover();
  assignment = assign(plan, () => prefixedUuid(PREFIX));
  s = await setUpUsers(
    client,
    stack,
    { tables: SYNCED.map((name) => ({ name, userColumns: new Set(plan.identityColumns) })), synced: SYNCED },
    { metadata: assignment.users.map((v) => metadataOf(assignment.paths, v)), paths: assignment.paths.map((p) => p.path) },
  );
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
  it("finds the role and the org in app_metadata, in the policies and the streams, and nothing it cannot read", async () => {
    const plan = await discover();
    expect(plan.uses.map((u) => [u.key, u.cls])).toEqual([
      ["app_metadata.org_id", "app_metadata"],
      ["app_metadata.role", "app_metadata"],
      ["sub", "identity"],
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
    expect(plan.identityColumns).toEqual(["owner_id"]);
    expect(plan.unreadable).toEqual([]);
  });
});


describe("run users holding the roles", () => {
  it("signs users up with each role, whose tokens carry it, labelled by it", () => {
    expect(s.fixed.users.map((u) => u.label)).toEqual([
      "u0 (app_metadata.role=admin)",
      "u1 (app_metadata.role=editor)",
      "u2 (app_metadata.role=samesight-other)",
      "u3 (app_metadata.role=admin)",
      "u4",
    ]);
    const tokens = new Map(s.fixed.users.map((u) => [u.label.split(" ")[0] as string, s.sessions.get(u.id)?.claims ?? {}]));
    expect(tokens.get("u1")).toMatchObject({ app_metadata: { role: "editor", provider: "email" } });
    const role = claimFindings(plan, undefined, tokens, assignment).find((f) => f.detail.startsWith("app_metadata.role"));
    expect(role).toMatchObject({ status: "ok", detail: expect.stringMatching(/; held: admin u0 u3, editor u1, samesight-other u2, none u4$/) });
  });
});

describe("coverage on the roles app", () => {
  it("sees every role policy and stream both ways, and the org ones, whose claim no user holds yet, only refusing", async () => {
    const config = parseSyncConfig(CONFIG);
    const cov = await coverageScope(client, SYNCED, config.streams, await policyFunctions(client), config.kind, new Set(assignment.paths.map((p) => p.key)));
    const result = await differential(s, { runs: 4, seed: 5, timeLimitMs: 120_000, coverage: cov });
    expect(result.findings.filter((f) => f.status === "fail")).toEqual([]);
    const policies = Object.fromEntries(cov.policies.map((p) => [`${p.table}: ${p.name}`, stateOf(p.tally)]));
    expect(policies).toEqual({
      "documents: admins read all": "exercised",
      "documents: editors read published": "exercised",
      "documents: no archived": "exercised",
      "documents: org members read": "only refused",
      "documents: own documents": "exercised",
      "orgs: admins read orgs": "exercised",
      "orgs: org members": "only refused",
      "orgs: org owners": "exercised",
    });
    const units = Object.fromEntries(cov.units.map((u) => [`${u.streams.join("+")} ${u.table}`, stateOf(u.tally)]));
    expect(units).toEqual({
      "admin documents": "exercised",
      "editor documents": "exercised",
      "org documents": "only refused",
      "own documents": "exercised",
      "admin orgs": "exercised",
      "org orgs": "only refused",
      "own orgs": "exercised",
    });
    expect(cov.notes).toEqual([expect.objectContaining({ status: "ok", detail: expect.stringMatching(/^what policies let users write .*: not measured/) })]);
    expect(cov.triggers).toEqual([]);
  }, 300_000);
});
