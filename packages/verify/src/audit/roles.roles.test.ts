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
import { readStack } from "../stack.ts";
import { checkAuditCatalog } from "./catalog.ts";
import { planClaims, policyFunctions, policyRules, syncRules } from "./claims.ts";

const APP = fileURLToPath(new URL("../../../../examples/audit-roles/", import.meta.url));
const SYNCED = ["documents", "orgs"];

let client: pg.Client;
beforeAll(async () => {
  client = await connectLocal(readStack(APP, "http://127.0.0.1").db);
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

describe("claim discovery on the roles app", () => {
  it("finds the role and the org in app_metadata, in the policies and the streams, and nothing it cannot read", async () => {
    const streams = syncRules(parseSyncConfig(readFileSync(`${APP}sync-config.yaml`, "utf8")));
    const plan = planClaims([...(await policyRules(client)), ...streams], await policyFunctions(client));
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
