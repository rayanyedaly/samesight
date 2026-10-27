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
  assignment = assign(plan, () => prefixedUuid(PREFIX), await readModel(client, SYNCED.map((name) => ({ name }))));
  s = await setUpUsers(
    client,
    stack,
    {
      tables: SYNCED.map((name) => {
        const pool = assignment.keyPools.get(name);
        return { name, userColumns: new Set(plan.identityColumns), claimValues: assignment.claimValues.get(name) ?? new Map(), ...(pool ? { keyPool: pool } : {}) };
      }),
      synced: SYNCED,
    },
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


describe("run users holding the roles and the orgs", () => {
  it("signs users up with every role and org together, whose tokens carry them, labelled by them", () => {
    const [orgA, orgB] = assignment.paths.find((p) => p.key === "app_metadata.org_id")?.pool ?? [];
    expect(assignment.paths.map((p) => [p.key, p.columns])).toEqual([
      ["app_metadata.org_id", ["orgs.id"]],
      ["app_metadata.role", []],
    ]);
    expect(assignment.keyPools.get("orgs")).toEqual({ column: "id", values: [orgA, orgB] });
    // Three roles by two orgs: all six combinations, a copy of the first user, and one with neither.
    const labels = s.fixed.users.map((u) => u.label.replace(String(orgA), "A").replace(String(orgB), "B"));
    expect(labels).toHaveLength(8);
    expect(new Set(labels.slice(0, 6))).toEqual(
      new Set(["A", "B"].flatMap((o) => ["admin", "editor", "samesight-other"].map((r) => `(app_metadata.org_id=${o}, app_metadata.role=${r})`)).map((x) => expect.stringContaining(x))),
    );
    expect(labels[6]?.replace(/^u\d+/, "")).toBe(labels[0]?.replace(/^u\d+/, ""));
    expect(labels[7]).toBe("u7");
    const tokens = new Map(s.fixed.users.map((u) => [u.label.split(" ")[0] as string, s.sessions.get(u.id)?.claims ?? {}]));
    expect(tokens.get("u0")).toMatchObject({ app_metadata: { provider: "email", org_id: expect.stringMatching(/^5a3e5a3e-/) } });
    const lines = claimFindings(plan, undefined, tokens, assignment);
    expect(lines.filter((f) => f.status !== "ok")).toEqual([]);
    expect(lines.find((f) => f.detail.startsWith("app_metadata.org_id"))?.detail).toMatch(/; generated rows take them in orgs\.id$/);
  });
});

describe("coverage on the roles app", () => {
  it("sees every policy and stream allowing and refusing a run user a row", async () => {
    const config = parseSyncConfig(CONFIG);
    const cov = await coverageScope(client, SYNCED, config.streams, await policyFunctions(client), config.kind, new Set(assignment.paths.map((p) => p.key)));
    const result = await differential(s, { runs: 4, seed: 5, timeLimitMs: 120_000, coverage: cov });
    expect(result.findings.filter((f) => f.status === "fail")).toEqual([]);
    expect(cov.policies.map((p) => [`${p.table}: ${p.name}`, stateOf(p.tally)]).filter(([, state]) => state !== "exercised")).toEqual([]);
    expect(cov.policies).toHaveLength(8);
    expect(cov.units.map((u) => [`${u.streams.join("+")} ${u.table}`, stateOf(u.tally)]).filter(([, state]) => state !== "exercised")).toEqual([]);
    expect(cov.units).toHaveLength(7);
    expect(cov.triggers).toEqual([]);
  }, 300_000);
});
