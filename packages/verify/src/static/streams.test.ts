import { definePolicy, table } from "samesight";
import { buildIR } from "samesight/compiler";
import { describe, expect, it } from "vitest";
import { ir, policy, schema, syncConfig } from "../fixtures/fieldbook.ts";
import { checkStreams, parseStreams } from "./streams.ts";

const check = (yaml: string, against = ir) => checkStreams(against, parseStreams(yaml));
const fails = (yaml: string, against = ir) => check(yaml, against).filter((f) => f.status === "fail").map((f) => f.detail);
const problems = (yaml: string) => check(yaml).filter((f) => f.status !== "ok").map((f) => f.detail);
/** Replaces exactly one occurrence, so a test cannot pass by matching nothing. */
function edit(from: string, to: string, yaml = syncConfig): string {
  const at = yaml.indexOf(from);
  if (at === -1 || yaml.indexOf(from, at + 1) !== -1) throw new Error(`expected one "${from}"`);
  return yaml.slice(0, at) + to + yaml.slice(at + from.length);
}

const ADMIN_SITE = `SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'ADMIN'`;
const adminSite = (sql: string) => edit(ADMIN_SITE, sql);
const NO_GATE = `admin.queries[2] (Site) has no tenant gate ("tenantId" = auth.parameter('tenant_id'))`;
const VIEWER_INSPECTION = `SELECT id, "tenantId", "siteId", "assigneeId", title, status, "createdAt", "updatedAt"`;
const HIDDEN = "viewer.queries[3] sends Inspection.internalNotes to VIEWER, which the policy hides from it";
/** Fieldbook, but only admins read sites. */
const adminSitesIR = buildIR(
  definePolicy({ ...policy.spec, tables: { ...policy.spec.tables, Site: table({ tenant: "tenantId", read: { ADMIN: true } }) } }),
  schema,
);

describe("checkStreams on Fieldbook", () => {
  it("passes the generated config", () => {
    const streams = parseStreams(syncConfig);
    const queries = streams.reduce((n, s) => n + s.queries.length, 0);
    expect(check(syncConfig)).toEqual([
      {
        status: "ok",
        check: "streams",
        detail: `${queries} queries in ${streams.length} streams carry the tenant gate and reach only roles with a read rule`,
      },
    ]);
  });

  it("fails a query or CTE without the tenant gate, including one with no WHERE", () => {
    expect(fails(adminSite(`SELECT * FROM "Site" WHERE auth.parameter('app_role') = 'ADMIN'`))).toEqual([NO_GATE]);
    expect(fails(adminSite(`SELECT * FROM "Site"`), adminSitesIR)).toEqual([
      NO_GATE,
      "admin.queries[2] streams Site to INSPECTOR, which has no read rule for it",
      "admin.queries[2] streams Site to VIEWER, which has no read rule for it",
      "inspector.queries[2] streams Site to INSPECTOR, which has no read rule for it",
      "viewer.queries[2] streams Site to VIEWER, which has no read rule for it",
    ]);
    expect(fails(edit(`WHERE "tenantId" = auth.parameter('tenant_id') AND "assigneeId" = auth.user_id()`, `WHERE "assigneeId" = auth.user_id()`))).toEqual([
      `inspector.with.inspection_visible has no tenant gate ("tenantId" = auth.parameter('tenant_id'))`,
    ]);
  });

  it("accepts the gates spelled in reverse, and a public-qualified table; refuses other schemas", () => {
    expect(fails(adminSite(`SELECT * FROM public."Site" WHERE auth.parameter('tenant_id') = "tenantId" AND 'ADMIN' = auth.parameter('app_role')`))).toEqual([]);
    expect(fails(adminSite(`SELECT * FROM other."Site" WHERE "tenantId" = auth.parameter('tenant_id')`))).toEqual([
      "admin.queries[2] cannot be read: reads other.Site, outside public",
    ]);
  });

  it("does not take a gate inside an OR, on another claim, in a comment, or as one quoted name", () => {
    const or = adminSite(`SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id') OR auth.parameter('app_role') = 'ADMIN'`);
    expect(fails(or)).toEqual([NO_GATE]);
    expect(fails(adminSite(`SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('org_id') AND auth.parameter('app_role') = 'ADMIN'`))).toEqual([NO_GATE]);
    const comment = `SELECT * FROM "Site" WHERE true AND /* AND "tenantId" = auth.parameter('tenant_id') AND */ auth.parameter('app_role') = 'ADMIN'`;
    expect(fails(adminSite(comment))).toEqual([`admin.queries[2] cannot be read: has "/*", which this check does not read`]);
    const quoted = `SELECT * FROM "Site" WHERE "tenantId = auth . parameter ( 'tenant_id' )" AND auth.parameter('app_role') = 'ADMIN'`;
    expect(fails(adminSite(quoted))).toEqual([NO_GATE]);
  });

  it("refuses SQL it does not model rather than splitting it wrongly", () => {
    const between = `SELECT * FROM "Site" WHERE id BETWEEN 'a' AND "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'ADMIN'`;
    expect(fails(adminSite(between))).toEqual(["admin.queries[2] cannot be read: uses BETWEEN, which this check does not read"]);
    expect(fails(adminSite(`SELECT * FROM "Site" WHERE name = E'\\'' AND "tenantId" = auth.parameter('tenant_id')`))).toEqual([
      `admin.queries[2] cannot be read: has a prefixed literal (E') that cannot be read safely`,
    ]);
    expect(fails(adminSite(`SELECT * FROM "Site" WHERE name = $$x$$ AND "tenantId" = auth.parameter('tenant_id')`))).toEqual([
      `admin.queries[2] cannot be read: has "$$", which this check does not read`,
    ]);
    const caseAnd = `SELECT * FROM "Site" WHERE CASE WHEN false THEN true AND "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'ADMIN' AND true ELSE true END`;
    expect(fails(adminSite(caseAnd))).toEqual(["admin.queries[2] cannot be read: uses CASE, which this check does not read"]);
    const array = `SELECT * FROM "Site" WHERE x = ARRAY[true AND "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'ADMIN']`;
    expect(fails(adminSite(array))).toEqual([`admin.queries[2] cannot be read: has "[t", which this check does not read`]);
    expect(fails(adminSite(`SELECT * FROM "Site" JOIN "Tenant" ON true WHERE "tenantId" = auth.parameter('tenant_id')`))).toEqual([
      `admin.queries[2] cannot be read: has "join" after the table; only WHERE is understood`,
    ]);
  });

  it("fails a table streamed to a role without a read rule, an ungated or unknown-role query, or a table outside the policy", () => {
    expect(fails(syncConfig, adminSitesIR)).toEqual([
      "inspector.queries[2] streams Site to INSPECTOR, which has no read rule for it",
      "viewer.queries[2] streams Site to VIEWER, which has no read rule for it",
    ]);
    const adminFails = (sql: string) => fails(adminSite(sql), adminSitesIR).filter((f) => f.startsWith("admin."));
    const everyRole = [
      "admin.queries[2] streams Site to INSPECTOR, which has no read rule for it",
      "admin.queries[2] streams Site to VIEWER, which has no read rule for it",
    ];
    expect(adminFails(`SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id')`)).toEqual(everyRole);
    expect(adminFails(`SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'SUPERADMIN'`)).toEqual(everyRole);
    const wrongTable = edit(
      `FROM "Tenant" WHERE id = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'VIEWER'`,
      `FROM "Secret" WHERE id = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'VIEWER'`,
    );
    expect(problems(wrongTable)).toEqual(["viewer.queries[0] streams Secret, which the policy does not cover", "VIEWER reads Tenant under RLS, but no stream sends it"]);
  });

  it("fails a hidden column sent to the role it is hidden from, however the projection names it", () => {
    const projections = ["SELECT *", `SELECT "Inspection".*`, `SELECT public."Inspection".*`, "SELECT id, *", `SELECT id, "internalNotes"`, "SELECT id, internalnotes"];
    for (const projection of projections) expect(fails(edit(VIEWER_INSPECTION, projection)), projection).toEqual([HIDDEN]);
  });

  it("fails an IN that names no CTE of its stream", () => {
    const yaml = edit(
      `          AND "inspectionId" IN inspection_visible\n          AND auth.parameter('app_role') = 'VIEWER'\n      - |\n        SELECT *\n        FROM "Photo"`,
      `          AND "inspectionId" IN nonexistent\n          AND auth.parameter('app_role') = 'VIEWER'\n      - |\n        SELECT *\n        FROM "Photo"`,
    );
    expect(fails(yaml)).toEqual(["viewer.queries[4] uses IN nonexistent, which is not a CTE of stream viewer"]);
  });

  it("does not stop at a literal that reads like a CTE reference", () => {
    expect(fails(adminSite(`SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id') AND name <> 'in nowhere'`))).toEqual([]);
    expect(fails(adminSite(`SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id') AND id IN subscription.parameter('ids')`))).toEqual([]);
  });

  it("warns, but does not fail, when a role reads a table under RLS that no stream sends", () => {
    const yaml = edit(`      - SELECT * FROM "Site" WHERE "tenantId" = auth.parameter('tenant_id') AND auth.parameter('app_role') = 'INSPECTOR'\n`, "");
    expect(check(yaml).map((f) => f.status)).toEqual(["ok", "warn"]);
    expect(problems(yaml)).toEqual(["INSPECTOR reads Site under RLS, but no stream sends it"]);
    // An empty config leaks nothing: it warns about every gap.
    const empty = check("config:\n  edition: 3\nstreams: {}\n");
    expect(empty.filter((f) => f.status === "fail")).toEqual([]);
    expect(empty.filter((f) => f.status === "warn")).toHaveLength([...ir.tables].reduce((n, t) => n + t.read.size, 0));
  });
});

describe("parseStreams", () => {
  it("refuses sections and keys it does not read, instead of skipping them", () => {
    expect(() => parseStreams(`${syncConfig}bucket_definitions:\n  leak:\n    data:\n      - SELECT * FROM "Inspection"\n`)).toThrow(
      "the sync config has bucket_definitions, which this check does not read; only streams are supported",
    );
    expect(() => parseStreams("streams:\n  s:\n    data:\n      - SELECT 1\n")).toThrow("stream s has data, which this check does not read");
    expect(() => parseStreams("config:\n  edition: 3\n")).toThrow("no streams: section");
  });

  it("refuses malformed queries, and labels a single query by its key", () => {
    expect(() => parseStreams("streams:\n  s:\n    queries: SELECT 1\n")).toThrow("queries must be a list of SQL strings");
    expect(() => parseStreams("streams:\n  s:\n    query: [a]\n")).toThrow("query must be a SQL string");
    expect(() => parseStreams("streams:\n  s:\n    with:\n      c: [a]\n")).toThrow("with must map names to SQL strings");
    expect(parseStreams("streams:\n  s:\n    query: SELECT 1\n")[0]?.queries).toEqual([{ label: "query", sql: "SELECT 1" }]);
  });
});
