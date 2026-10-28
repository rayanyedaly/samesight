/**
 * The catalog checks against the running local stack: Fieldbook as generated passes, and
 * each tampering fails. Every tamper runs inside a transaction that is rolled back, as
 * supabase_admin (some need a superuser), so the database is left as it was.
 */

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "../db.ts";
import { FIELDBOOK, latestMigration, read } from "../fixtures/fieldbook.ts";
import { checkCatalogParity } from "./catalog-parity.ts";
import { checkCatalog } from "./catalog.ts";
import type { Manifest } from "./manifest.ts";

const DB = process.env.SAMESIGHT_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ADMIN = DB.replace("//postgres:", "//supabase_admin:");
const manifest = JSON.parse(read("samesight/manifest.json")) as Manifest;

let client: pg.Client;
let admin: pg.Client;
beforeAll(async () => {
  client = await connectLocal(DB);
  admin = await connectLocal(ADMIN);
});
afterAll(async () => {
  await client?.end();
  await admin?.end();
});

/** Failures and warnings from checkCatalog with the tamper applied, read on the same connection, then rolled back. */
async function failsWith(tamper: string): Promise<string[]> {
  await admin.query("begin");
  try {
    await admin.query(tamper);
    return (await checkCatalog(admin, manifest, "powersync")).filter((f) => f.status !== "ok").map((f) => `${f.check}: ${f.detail}`);
  } finally {
    await admin.query("rollback");
  }
}

describe("checkCatalog on the local Fieldbook database", () => {
  it(`passes the database ${FIELDBOOK} generates`, async () => {
    const findings = await checkCatalog(client, manifest, "powersync");
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    expect(findings.map((f) => f.check)).toEqual([
      "row level security",
      "policies",
      "roles",
      "anon",
      "views",
      "token hook",
      "publication",
      "append-only",
    ]);
  });

  it.each([
    ["grant supabase_auth_admin to authenticated", "roles: authenticated has the privileges of supabase_auth_admin"],
    ["alter role authenticated bypassrls", "roles: authenticated has BYPASSRLS"],
    [`alter table public."Site" owner to authenticated`, "roles: authenticated owns Site, so RLS does not apply to it there"],
    ["grant authenticated to anon", "roles: anon has the privileges of authenticated"],
    [`grant select on public."Tenant" to public`, "anon: anon has a table privilege on Tenant"],
    [`grant select ("name") on public."Tenant" to anon`, "anon: anon has a column privilege on Tenant"],
    [`alter policy "Site: read" on public."Site" to authenticated, anon`, `anon: policy "Site: read" on Site applies to anon`],
    ["grant execute on function public.record_rejection(jsonb) to anon", "anon: anon can execute record_rejection(jsonb)"],
    [`alter table public."Inspection" disable row level security`, "row level security: off on public.Inspection"],
    [
      `create policy "x" on public."Site" as restrictive for select to authenticated using (false)`,
      `policies: Site has "x" (hand-written), which the policy does not generate; a restrictive policy narrows RLS below what devices sync`,
    ],
    [
      `alter policy "Site: read" on public."Site" to public`,
      `policies: "Site: read" is for SELECT to public; the policy generates it for SELECT to authenticated`,
    ],
    [`create view public.sites as select * from public."Site"; grant select on public.sites to anon`, "views: public.sites reads public.Site"],
    [
      `create schema api; grant usage on schema api to authenticated; create view api.sites as select * from public."Site"; grant select on api.sites to authenticated`,
      "views: api.sites reads public.Site through a view with its owner's rights (not security_invoker), and authenticated can select it",
    ],
    [
      `create schema priv; create view priv.s as select * from public."Site"; create view public.s2 with (security_invoker = on) as select * from priv.s; grant select on public.s2 to authenticated`,
      "views: public.s2 reads public.Site",
    ],
    [
      `create schema priv; create function priv.f() returns setof public."Site" language sql stable security definer set search_path = '' as 'select * from public."Site"'; create view public.v with (security_invoker = on) as select * from priv.f(); grant select on public.v to authenticated`,
      "views: public.v reads rows through priv.f(), which runs as its owner",
    ],
    [`create view public.rejections as select * from samesight."RejectedWrite"; grant select on public.rejections to authenticated`, "views: public.rejections reads samesight.RejectedWrite"],
    [`alter table samesight."RejectedWrite" owner to authenticated`, "roles: authenticated owns RejectedWrite"],
    [
      `drop trigger "Finding_append_only" on public."Finding"; create trigger "Finding_append_only" before update or delete on public."Finding" for each row when (false) execute function samesight.reject_mutation()`,
      "append-only: Finding_append_only is not the generated trigger",
    ],
    [
      `drop trigger "Photo_append_only" on public."Photo"; create trigger "Photo_append_only" before update of "storagePath" or delete on public."Photo" for each row execute function samesight.reject_mutation()`,
      "append-only: Photo_append_only is not the generated trigger",
    ],
    [`revoke execute on function samesight.custom_access_token_hook(jsonb) from supabase_auth_admin`, "token hook: supabase_auth_admin cannot execute it"],
    [`grant execute on function samesight.custom_access_token_hook(jsonb) to authenticated`, "token hook: authenticated can execute it"],
    [
      "drop function samesight.custom_access_token_hook(jsonb)",
      "token hook: samesight.custom_access_token_hook(jsonb) does not exist; apply the migration samesight generate writes (supabase migration up), or, if it is already applied, supabase db reset (which resets the local data)",
    ],
    ["drop publication powersync", "publication: powersync does not exist; apply the migration samesight generate writes (supabase migration up), or, if it is already applied, supabase db reset (which resets the local data); the migration creates it with the synced tables"],
    [`alter publication powersync set (publish = 'insert, update')`, "publication: does not publish delete"],
    [`alter publication powersync set table public."Tenant" where (true), public."Membership", public."Site", public."Inspection", public."Finding", public."Photo"`, "publication: filters rows or columns of"],
    [`alter publication powersync drop table public."Photo"`, "publication: missing public.Photo"],
    [`alter table public."Finding" enable replica trigger "Finding_append_only"`, "append-only: Finding_append_only does not fire in normal sessions (tgenabled R)"],
    [`drop trigger "Photo_no_truncate" on public."Photo"`, "append-only: Photo_no_truncate is missing"],
  ])("flags: %s", async (tamper, expected) => {
    const fails = await failsWith(tamper);
    expect(fails.some((f) => f.startsWith(expected)), fails.join("\n")).toBe(true);
  });
});

describe("checkCatalogParity on the local Fieldbook database", () => {
  it("re-applies the latest generated migration without a change, twice", async () => {
    expect(await checkCatalogParity(client, "latest.sql", latestMigration())).toEqual([
      { status: "ok", check: "catalog parity", detail: "re-applying latest.sql changes nothing" },
      { status: "ok", check: "catalog parity", detail: "latest.sql applies twice in a row without error" },
    ]);
  });

  it("names what a migration would change", async () => {
    // Drift seen from the other side: the database is untouched and the migration differs.
    const migration = latestMigration();
    const site = /(create policy "Site: read" on public\."Site"\s+for select to authenticated\s+using \()[\s\S]*?(\n {2}\);)/;
    expect(migration).toMatch(site);
    const findings = await checkCatalogParity(client, "edited.sql", migration.replace(site, "$1true$2"));
    expect(findings[0]?.status).toBe("fail");
    expect(findings[0]?.detail).toMatch(/^the database differs from edited\.sql: policies: public \/ Site \/ Site: read: qual is ".+", the migration makes it "true"$/);
  });
});
