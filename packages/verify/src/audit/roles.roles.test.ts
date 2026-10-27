/**
 * Audit on examples/audit-roles, an app whose RLS and sync streams read a role and an org
 * from app_metadata: pnpm --filter audit-roles stack:up first.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { parseSyncConfig } from "samesight/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { PREFIX, setUpUsers, tearDown } from "../differential/run.ts";
import { prefixedUuid } from "../differential/world.ts";
import { readStack } from "../stack.ts";
import { assignClaims, metadataOf } from "./assign.ts";
import { checkAuditCatalog } from "./catalog.ts";
import { claimFindings, planClaims, policyFunctions, policyRules, syncRules } from "./claims.ts";

const APP = fileURLToPath(new URL("../../../../examples/audit-roles/", import.meta.url));
const SYNCED = ["documents", "orgs"];

let client: pg.Client;
const stack = readStack(APP, "http://127.0.0.1");
beforeAll(async () => {
  client = await connectLocal(stack.db);
});
afterAll(async () => {
  await client?.end();
});

describe("the roles app's catalog", () => {
  it("passes, with the restrictive policy listed as such", async () => {
    const findings = await checkAuditCatalog(client, SYNCED);
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    expect(findings).toContainEqual(expect.objectContaining({ check: "policies", detail: expect.stringContaining('"no archived" (SELECT to authenticated, restrictive)') }));
  });
});

const discover = async () =>
  planClaims([...(await policyRules(client)), ...syncRules(parseSyncConfig(readFileSync(`${APP}sync-config.yaml`, "utf8")))], await policyFunctions(client));

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
  it("signs users up with each role, whose tokens carry it, labelled by it", async () => {
    const plan = await discover();
    const assignment = assignClaims(plan, () => prefixedUuid(PREFIX));
    const s = await setUpUsers(
      client,
      stack,
      { tables: SYNCED.map((name) => ({ name })), synced: SYNCED },
      { metadata: assignment.users.map((v) => metadataOf(assignment.paths, v)), paths: assignment.paths.map((p) => p.path) },
    );
    try {
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
    } finally {
      await tearDown(s);
    }
  });
});
