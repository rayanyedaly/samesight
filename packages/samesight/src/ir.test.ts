import { describe, expect, it } from "vitest";
import { fieldbookPolicy, fieldbookSchema } from "./fixtures/fieldbook.ts";
import { buildIR, CompileError } from "./ir.ts";
import { and, claim, col, definePolicy, or, type PolicySpec, raw, rowsOf, table, via } from "./policy.ts";

const base = fieldbookPolicy.spec;
function compile(tables: PolicySpec["tables"], extra: Partial<PolicySpec> = {}) {
  // Every policy must govern its membership table, so the tests keep Fieldbook's.
  return buildIR(definePolicy({ ...base, ...extra, tables: { Membership: base.tables.Membership, ...tables } }), fieldbookSchema);
}
function problems(tables: PolicySpec["tables"], extra: Partial<PolicySpec> = {}): string[] {
  try {
    compile(tables, extra);
  } catch (e) {
    if (e instanceof CompileError) return e.problems;
    throw e;
  }
  return [];
}

describe("buildIR on Fieldbook", () => {
  const ir = buildIR(fieldbookPolicy, fieldbookSchema);
  const tbl = (name: string) => {
    const found = ir.tables.find((t) => t.name === name);
    if (!found) throw new Error(name);
    return found;
  };

  it("expands * to every role and merges write into insert, update and delete", () => {
    expect([...tbl("Tenant").read.keys()]).toEqual(["ADMIN", "INSPECTOR", "VIEWER"]);
    expect(tbl("Site").insert.get("ADMIN")).toBe(true);
    expect(tbl("Site").delete.get("ADMIN")).toBe(true);
    expect(tbl("Site").update.has("INSPECTOR")).toBe(false);
    expect(ir.tenantTable).toBe("Tenant");
  });

  it("derives the write allowlists the hand-written apply_batch uses", () => {
    expect(tbl("Site").insertColumns).toEqual(["name", "address"]);
    expect(tbl("Site").updateColumns).toEqual(["name", "address"]);
    expect(tbl("Inspection").insertColumns).toEqual(["siteId", "assigneeId", "title", "status", "internalNotes"]);
    expect(tbl("Inspection").updateColumns).toEqual(["assigneeId", "title", "status", "internalNotes"]);
    expect(tbl("Finding").insertColumns).toEqual(["inspectionId", "supersedesId", "body", "severity"]);
    expect(tbl("Finding").updateColumns).toEqual([]);
    expect(tbl("Photo").insertColumns).toEqual(["inspectionId", "findingId", "storagePath", "sha256"]);
    expect(tbl("Finding").identityColumns).toEqual(["seq"]);
  });

  it("warns, rather than fails, on a via column without an index", () => {
    expect(ir.warnings).toEqual([]);
    const schema = structuredClone(fieldbookSchema);
    const photo = schema.tables.find((t) => t.name === "Photo");
    if (photo) photo.indexedColumns = [];
    expect(buildIR(fieldbookPolicy, schema).warnings).toEqual([
      'Photo: via("inspectionId", "Inspection") has no index on "inspectionId"; RLS checks will scan',
    ]);
  });
});

describe("compile errors", () => {
  it("names unknown tables, columns and roles", () => {
    expect(
      problems({
        Nope: table({ tenant: "tenantId" }),
        Site: table({ tenant: "tenantId", read: { OWNER: true, ADMIN: col("nam").eq("x") } }),
      }),
    ).toEqual([
      'Nope: no table "Nope" in the database (run `supabase start` and apply the migrations first)',
      'Site.read: unknown role "OWNER" (claims.role lists ADMIN, INSPECTOR, VIEWER)',
      'Site.read.ADMIN: no column "nam" in "Site"',
    ]);
  });

  it("refuses rules sync streams cannot express", () => {
    expect(
      problems({
        Membership: table({ tenant: "tenantId", read: { ADMIN: true } }),
        Site: table({ tenant: "tenantId", read: { ADMIN: raw({ rls: "\"createdAt\" > now() - interval '1 day'", sync: "true" }) } }),
      }),
    ).toEqual(["Site.read.ADMIN: raw rule depends on the clock; sync buckets cannot re-evaluate on time, so scope by status instead"]);
  });

  it("refuses raw rules that could escape the parentheses around them", () => {
    const site = (rls: string, sync = "true") => problems({ Site: table({ tenant: "tenantId", read: { ADMIN: raw({ rls, sync }) } }) });
    expect(site("x) or (true")).toEqual(["Site.read.ADMIN: raw rules need balanced parentheses and closed quotes"]);
    expect(site("true", "name = 'a")).toEqual(["Site.read.ADMIN: raw rules need balanced parentheses and closed quotes"]);
    expect(site("(name = ')') and (\"x(\" is null)")).toEqual([]);
    expect(site("name = 'it''s (open'")).toEqual([]);
    const quoting = ["Site.read.ADMIN: raw rules cannot contain $ or \\ (dollar quoting, escape strings)"];
    expect(site("x = E'\\'') or true or (x = E'\\'")).toEqual(quoting);
    expect(site("x = $$'$$) or true or (x = $$'$$")).toEqual(quoting);
  });

  it("refuses hiding a column from a role that can update it", () => {
    expect(
      problems({
        Inspection: table({ tenant: "tenantId", read: { "*": true }, update: { VIEWER: true }, hide: { "*": ["internalNotes", "siteId"] }, immutable: ["siteId"] }),
      }),
    ).toEqual(["Inspection.hide.VIEWER: VIEWER updates this table, so hidden columns must be immutable or server-owned (internalNotes)"]);
  });

  it("refuses a via to a parent the role cannot read, or one that nests", () => {
    expect(
      problems({
        Inspection: table({ tenant: "tenantId", read: { ADMIN: true, VIEWER: via("siteId", "Site") } }),
        Site: table({ tenant: "tenantId", read: { ADMIN: true } }),
        Finding: table({ tenant: "tenantId", read: { VIEWER: via("inspectionId", "Inspection") } }),
      }),
    ).toEqual([
      'Inspection.read.VIEWER: reads through via("siteId", "Site"), but VIEWER has no read rule on "Site"',
      'Finding.read.VIEWER: via("inspectionId", "Inspection") reaches a parent whose own VIEWER rule uses via or rowsOf; sync streams cannot nest them',
    ]);
  });

  it("refuses updates on append-only tables and writes to the tenant table", () => {
    expect(
      problems({
        Tenant: table({ tenant: "id", read: { "*": true }, write: { ADMIN: true } }),
        Finding: table({ tenant: "tenantId", read: { "*": true }, write: { ADMIN: true }, appendOnly: {} }),
      }),
    ).toEqual([
      'Tenant: the tenant table (tenant: "id") cannot be written by clients',
      "Finding: append-only tables take insert rules only, not update, delete or write",
    ]);
  });

  it("refuses unsafe literals, empty lists and an author without auth.uid()", () => {
    expect(
      problems({
        Site: table({ tenant: "tenantId", read: { ADMIN: col("name").eq("x' or '1'='1"), VIEWER: col("name").in([]) } }),
        Inspection: table({ tenant: "tenantId", author: "assigneeId" }),
      }),
    ).toEqual([
      `Site.read.ADMIN: the literal "x' or '1'='1" contains a quote, backslash, # or control character`,
      'Site.read.VIEWER: col("name").in([]) matches nothing; remove the rule instead',
      'Inspection.author: "assigneeId" needs the column default auth.uid(); inserts are checked against it',
    ]);
  });

  it("refuses malformed rules from untyped policy files", () => {
    const loose = (rule: unknown) => rule as never;
    expect(
      problems({
        Site: table({
          tenant: "tenantId",
          read: { ADMIN: loose(false), INSPECTOR: col("name").eq(loose(null)), VIEWER: loose({ kind: "not" }) },
          write: { ADMIN: col("name").in([loose({ kind: "user" })]) },
        }),
      }),
    ).toEqual([
      "Site.read.ADMIN: a rule is `true` or a condition, not false",
      'Site.read.VIEWER: a rule is `true` or a condition, not {"kind":"not"}',
      "Site.read.INSPECTOR: null is not a string, number or boolean",
      'Site.insert.ADMIN: {"kind":"user"} is not a string, number or boolean',
      'Site.update.ADMIN: {"kind":"user"} is not a string, number or boolean',
      'Site.delete.ADMIN: {"kind":"user"} is not a string, number or boolean',
      'Site: ADMIN writes "Site" but has no read rule on it; writes read the row back',
    ]);
    expect(
      problems({
        Site: table({
          tenant: "tenantId",
          read: { ADMIN: loose({ kind: "and" }), VIEWER: loose({ kind: "inRows", column: "name" }) },
          hide: { ADMIN: loose("name") },
        }),
      }),
    ).toEqual([
      'Site.read.ADMIN: a rule is `true` or a condition, not {"kind":"and"}',
      'Site.read.VIEWER: a rule is `true` or a condition, not {"kind":"inRows","column":"name"}',
      "Site.hide.ADMIN: a list of columns",
    ]);
  });

  it("checks literals against the column type", () => {
    expect(
      problems({
        Inspection: table({
          tenant: "tenantId",
          read: {
            ADMIN: col("siteId").eq("ABC"),
            INSPECTOR: col("createdAt").eq("2026-01-01"),
            VIEWER: col("title").eq(claim.user),
          },
        }),
        Finding: table({ tenant: "tenantId", read: { ADMIN: col("seq").in([1.5]) } }),
      }),
    ).toEqual([
      'Inspection.read.ADMIN: "ABC" does not fit "siteId" (uuid); it takes a lowercase canonical uuid string',
      'Inspection.read.INSPECTOR: "2026-01-01" does not fit "createdAt" (timestamp with time zone); it takes no literal (time comparisons differ between Postgres and PowerSync; use a status column)',
      'Inspection.read.VIEWER: "title" is text; claim.user compares with a uuid column',
      'Finding.read.ADMIN: 1.5 does not fit "seq" (bigint); it takes an integer',
    ]);
  });

  it("keeps via where streams can express it, and rowsOf on policy tables", () => {
    expect(
      problems({
        Inspection: table({ tenant: "tenantId", read: { ADMIN: true }, check: col("assigneeId").in(rowsOf("Site", "id")) }),
        Finding: table({ tenant: "tenantId", read: { ADMIN: or(via("inspectionId", "Inspection"), col("body").eq("x")) } }),
      }),
    ).toEqual([
      'Inspection.check: rowsOf("Site", ...): "Site" is not a table in this policy, so its rows are not tenant-scoped',
      "Finding.read.ADMIN: via and rowsOf must stand alone or be a term of a top-level and(); sync streams cannot put them under or() (rules for \"*\" and for a role are ORed together)",
    ]);
  });

  it("reads through rowsOf where the target's rule for the role can be repeated in a stream", () => {
    const membership = table({ tenant: "tenantId", read: { ADMIN: true, INSPECTOR: col("userId").eq(claim.user) } });
    const site = table({ tenant: "tenantId", read: { ADMIN: true, INSPECTOR: true } });
    expect(
      problems({
        Membership: membership,
        Inspection: table({ tenant: "tenantId", read: { INSPECTOR: or(col("status").eq("DRAFT"), col("assigneeId").in(rowsOf("Membership", "userId"))) } }),
        Finding: table({ tenant: "tenantId", read: { ADMIN: col("inspectionId").in(rowsOf("Site", "id", via("id", "Site"))) } }),
      }),
    ).toEqual([
      'Inspection.read.INSPECTOR: via and rowsOf must stand alone or be a term of a top-level and(); sync streams cannot put them under or() (rules for "*" and for a role are ORed together)',
      'Finding.read.ADMIN: rowsOf("Site", ...): "Site" is not a table in this policy, so its rows are not tenant-scoped',
    ]);
    expect(
      problems({
        Membership: membership,
        Site: site,
        Inspection: table({
          tenant: "tenantId",
          read: { ADMIN: and(col("status").eq("PUBLISHED"), via("siteId", "Site")), VIEWER: col("assigneeId").in(rowsOf("Membership", "userId")) },
        }),
        Finding: table({ tenant: "tenantId", read: { ADMIN: col("inspectionId").in(rowsOf("Inspection", "id")) } }),
        Photo: table({ tenant: "tenantId", read: { ADMIN: col("inspectionId").in(rowsOf("Inspection", "id", via("siteId", "Site"))) } }),
      }),
    ).toEqual([
      'Photo.read.ADMIN: rowsOf("Inspection", ...) in a read rule cannot filter with via or rowsOf',
      'Inspection.read.VIEWER: reads through rowsOf("Membership", "userId"), but VIEWER has no read rule on "Membership"',
      'Finding.read.ADMIN: rowsOf("Inspection", "id") reaches a table whose own ADMIN rule uses via or rowsOf; sync streams cannot nest them',
    ]);
  });

  it("refuses claim names Supabase owns", () => {
    expect(
      problems(
        { Membership: table({ tenant: "tenantId", read: { ADMIN: true } }) },
        { claims: { tenant: claim.uuid("sub"), role: claim.oneOf("role", ["ADMIN"]) } },
      ),
    ).toEqual([
      'claims.tenant: "sub" is a claim Supabase sets itself; pick another name (e.g. app_sub)',
      'claims.role: "role" is a claim Supabase sets itself; pick another name (e.g. app_role)',
    ]);
  });

  it("checks claims and membership", () => {
    expect(
      problems(
        { Membership: table({ tenant: "tenantId", read: { ADMIN: true } }) },
        {
          claims: { tenant: claim.uuid("Tenant-Id"), role: claim.oneOf("app_role", ["ADMIN", "ADMIN"]) },
          membership: { table: "Membership", user: "user_id", tenant: "tenantId", role: "role" },
        },
      ),
    ).toEqual([
      "claims.role lists a role twice",
      'claims.tenant: claim name "Tenant-Id" must be lowercase letters, digits and underscores',
      'membership.user: no column "user_id" in "Membership"',
    ]);
  });
});
