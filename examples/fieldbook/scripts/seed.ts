// Seeds the local Fieldbook stack: two tenants, one user per role in each, and
// inspections in every status, so tenant isolation and every role rule can be seen.
//
// Run with `pnpm --filter fieldbook seed` after `pnpm --filter fieldbook stack:up`.
// To start over: `pnpm --filter fieldbook db:reset` (wipes and reseeds).
//
// Refuses to run against anything but the local Supabase stack, because it creates
// users with a published demo password using the secret key.

import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

export const DEMO_PASSWORD = "fieldbook-demo";

type Role = "ADMIN" | "INSPECTOR" | "VIEWER";

function localStatus(): { url: string; secretKey: string } {
  // A fixed command with no interpolated input; a shell is needed to run pnpm on Windows.
  const out = execSync("pnpm exec supabase status -o env", { encoding: "utf8" });
  const env = Object.fromEntries(
    out
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)="?(.*?)"?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
  const url = env.API_URL;
  const secretKey = env.SECRET_KEY || env.SERVICE_ROLE_KEY;
  if (!url || !secretKey) throw new Error("supabase status did not report API_URL and a secret key");
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to seed a non-local Supabase project (${host})`);
  }
  return { url, secretKey };
}

const { url, secretKey } = localStatus();
const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

type Result<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

/** For reads: the data, or throw. */
async function must<T>(label: string, p: Result<T>): Promise<T> {
  const { data, error } = await p;
  if (error || data === null) throw new Error(`${label}: ${error?.message ?? "no data"}`);
  return data;
}

/** For writes: PostgREST returns no body for an insert without .select(), so only the error counts. */
async function ok(label: string, p: Result<unknown>): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: DEMO_PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`create user ${email}: ${error?.message}`);
  return data.user.id;
}

const existing = await must("check existing tenants", admin.from("Tenant").select("id").limit(1));
if (existing.length > 0) {
  console.log("Already seeded. To start over: pnpm --filter fieldbook db:reset");
  process.exit(0);
}

const tenants = [
  { slug: "northwind", name: "Northwind Surveys", sites: ["Pier 4 Warehouse", "Elm Street Depot"] },
  { slug: "harbor", name: "Harbor Utilities", sites: ["Substation 12", "Pump House North"] },
];

const accounts: { email: string; role: Role; tenant: string }[] = [];

for (const t of tenants) {
  const tenantId = crypto.randomUUID();
  await ok(`tenant ${t.slug}`, admin.from("Tenant").insert({ id: tenantId, name: t.name }));

  const users: Record<Role, string> = { ADMIN: "", INSPECTOR: "", VIEWER: "" };
  for (const role of ["ADMIN", "INSPECTOR", "VIEWER"] as const) {
    const email = `${role.toLowerCase()}@${t.slug}.test`;
    users[role] = await createUser(email);
    await ok(
      `membership ${email}`,
      admin.from("Membership").insert({
        userId: users[role],
        tenantId,
        role,
        displayName: `${t.name.split(" ")[0]} ${role.charAt(0)}${role.slice(1).toLowerCase()}`,
      }),
    );
    accounts.push({ email, role, tenant: t.name });
  }

  const siteIds = t.sites.map(() => crypto.randomUUID());
  await ok(
    `sites ${t.slug}`,
    admin.from("Site").insert(
      t.sites.map((name, i) => ({ id: siteIds[i], tenantId, name, address: `${i + 1} ${t.name} Way` })),
    ),
  );

  // One inspection per status at the first site, plus an unassigned draft at the second.
  const inspections = [
    { title: "Roof and drainage", status: "IN_PROGRESS", assigneeId: users.INSPECTOR, siteId: siteIds[0] },
    { title: "Fire exits", status: "PUBLISHED", assigneeId: users.INSPECTOR, siteId: siteIds[0] },
    { title: "Loading dock (2025)", status: "ARCHIVED", assigneeId: users.INSPECTOR, siteId: siteIds[0] },
    { title: "Electrical survey", status: "DRAFT", assigneeId: null, siteId: siteIds[1] },
  ].map((i) => ({
    id: crypto.randomUUID(),
    tenantId,
    ...i,
    internalNotes: `Internal: ${t.name} staff only. Follow up on access codes for "${i.title}".`,
  }));
  await ok(`inspections ${t.slug}`, admin.from("Inspection").insert(inspections));

  // Findings: two on the in-progress inspection, and on the published one a finding
  // and its amendment.
  const original = crypto.randomUUID();
  const findings = [
    { inspectionId: inspections[0].id, body: "Gutter blocked above bay 3.", severity: "MEDIUM" },
    { inspectionId: inspections[0].id, body: "Flashing loose on north edge.", severity: "LOW" },
    { id: original, inspectionId: inspections[1].id, body: "Exit sign unlit.", severity: "HIGH" },
    {
      inspectionId: inspections[1].id,
      supersedesId: original,
      body: "Exit sign unlit; replaced during visit, retest passed.",
      severity: "LOW",
    },
    { inspectionId: inspections[2].id, body: "Dock leveller serviced.", severity: "LOW" },
  ];
  // Insert one at a time so seq follows this order (the amendment after its original).
  for (const f of findings) {
    await ok(
      `finding ${t.slug}`,
      admin.from("Finding").insert({ id: crypto.randomUUID(), ...f, tenantId, createdBy: users.INSPECTOR }),
    );
  }
}

console.log(`Seeded. Every account's password is "${DEMO_PASSWORD}".`);
console.table(accounts);
