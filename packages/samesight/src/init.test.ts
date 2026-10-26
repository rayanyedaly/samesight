import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldbookSchema } from "./fixtures/fieldbook.ts";
import { draftPolicy, findMembership } from "./init.ts";
import { buildIR } from "./ir.ts";
import { loadPolicy } from "./load.ts";
import type { SchemaInfo } from "./schema.ts";

/** Loads a drafted policy the way the CLI would, with "samesight" pointing at this source. */
async function load(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "samesight-init-"));
  const path = join(dir, "samesight.policy.mts");
  writeFileSync(path, source.replace('from "samesight"', `from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}`));
  return loadPolicy(path);
}

describe("draftPolicy", () => {
  it("finds the membership and tenant tables", () => {
    expect(findMembership(fieldbookSchema)).toEqual({ table: "Membership", user: "userId", tenant: "tenantId", role: "role" });
  });

  it("drafts a policy from the schema that compiles as written", async () => {
    const draft = draftPolicy(fieldbookSchema, { roles: ["ADMIN", "INSPECTOR", "VIEWER"] });
    expect(draft.notes).toContain("membership: Membership (userId -> tenantId, role)");
    expect(draft.notes).toContain("tenant table: Tenant");
    expect(draft.source).toContain('role: claim.oneOf("app_role", ["ADMIN", "INSPECTOR", "VIEWER"])');
    expect(draft.source).toContain('    Tenant: table({ tenant: "id", read: { "*": true } }),\n    Membership: table({ tenant: "tenantId", read: { "*": col("userId").eq(claim.user) } }),');
    const ir = buildIR(await load(draft.source), fieldbookSchema);
    expect(ir.tables.map((t) => t.name)).toEqual(["Tenant", "Membership", "Finding", "Inspection", "Photo", "Site"]);
    for (const t of ir.tables) expect(t.insert.size + t.update.size + t.delete.size).toBe(0);
  });

  it("leaves out tables it cannot scope, and says why", async () => {
    const schema: SchemaInfo = {
      tables: [
        ...fieldbookSchema.tables,
        { name: "Setting", columns: [{ name: "id", type: "uuid", nullable: false, default: null, identity: false, generated: false }], primaryKey: ["id"], indexedColumns: ["id"], uniqueColumns: ["id"], foreignKeys: [] },
        { name: "Log", columns: [{ name: "seq", type: "bigint", nullable: false, default: null, identity: true, generated: false }], primaryKey: ["seq"], indexedColumns: ["seq"], uniqueColumns: ["seq"], foreignKeys: [] },
      ],
    };
    const draft = draftPolicy(schema);
    expect(draft.notes).toContain("left out Setting: no NOT NULL uuid tenant column");
    expect(draft.notes).toContain('left out Log: the primary key is not a single "id" column');
    expect(draft.notes.some((n) => n.startsWith("roles: ADMIN, MEMBER (placeholders"))).toBe(true);
    expect(draft.source).toContain("    // Left out: Setting: no NOT NULL uuid tenant column.");
    buildIR(await load(draft.source), schema);
  });

  it("writes a template without a database or a membership table", () => {
    expect(draftPolicy(null).source).toContain('membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" }');
    const none = draftPolicy({ tables: [] });
    expect(none.notes[0]).toMatch(/no membership table found/);
  });
});

describe("draftPolicy with hostile names", () => {
  it("never lets a table name end a comment and add a line of code", () => {
    const column = (name: string) => ({ name, type: "uuid", nullable: false, default: null, identity: false, generated: false });
    const evil = (name: string) => ({ name, columns: [column("id")], primaryKey: ["id"], indexedColumns: ["id"], uniqueColumns: ["id"], foreignKeys: [] });
    const draft = draftPolicy({
      tables: [...fieldbookSchema.tables, evil("x\nconsole.log('PWNED')//"), evil("y\u2028console.log('PWNED')//")],
    });
    const lines = draft.source.split(/\r?\n|\u2028|\u2029/);
    expect(lines.some((l) => l.startsWith("console.log"))).toBe(false);
    expect(draft.source).toContain('// Left out: "x\\nconsole.log(\'PWNED\')//": the name needs quoting.');
    expect(draft.source).toContain("\\u2028");
  });

  it("ignores a membership table whose name is not an identifier", () => {
    const tables = fieldbookSchema.tables.map((t) => (t.name === "Membership" ? { ...t, name: "Member ship" } : t));
    expect(findMembership({ tables })).toBeNull();
  });
});
