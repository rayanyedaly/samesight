/**
 * `samesight init`: a first policy file. With the local database running it is drafted
 * from the schema (membership table, tenant table, each table's tenant column, the role
 * values) and compiles as written: every role reads every row of its own tenant, each
 * user reads their own membership, and nothing is writable yet. Without a database it is
 * a template to fill in.
 */

import type pg from "pg";
import { findColumn, type SchemaInfo, type TableInfo } from "./schema.ts";

export interface Draft {
  source: string;
  /** What was found and what was left out, for the person running init. */
  notes: string[];
}

export interface DraftOptions {
  /** The `supabase gen types` output, relative to the policy file. */
  typesFile?: string;
  /** Values of the membership role column, when the database lists them (enum or CHECK). */
  roles?: string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TENANT_COLUMN = /^(tenant|org|organization|organisation|team|workspace|account|company)_?id$/i;
const USER_COLUMN = /^(user|profile|member|account)_?id$/i;
const ROLE_COLUMN = /^(app_?)?role$/i;
const DEFAULT_ROLES = ["ADMIN", "MEMBER"];

/** The membership table: one row per user (unique uuid user column), with a tenant and a role. */
export function findMembership(schema: SchemaInfo): { table: string; user: string; tenant: string; role: string } | null {
  for (const t of schema.tables) {
    const uuid = (c: string) => findColumn(t, c)?.type === "uuid";
    const user = t.columns.find((c) => USER_COLUMN.test(c.name) && uuid(c.name) && t.uniqueColumns.includes(c.name));
    const tenant = t.columns.find((c) => TENANT_COLUMN.test(c.name) && uuid(c.name) && c.name !== user?.name);
    const role = t.columns.find((c) => ROLE_COLUMN.test(c.name));
    // Only identifiers: these names are written into the policy's source and comments.
    if (user && tenant && role && [t.name, user.name, tenant.name, role.name].every((n) => IDENT.test(n))) {
      return { table: t.name, user: user.name, tenant: tenant.name, role: role.name };
    }
  }
  return null;
}

export function draftPolicy(schema: SchemaInfo | null, options: DraftOptions = {}): Draft {
  const typesFile = options.typesFile ?? "supabase/types.ts";
  const roles = options.roles?.length && options.roles.every((r) => IDENT.test(r)) ? options.roles : DEFAULT_ROLES;
  const notes: string[] = [];
  const membership = schema ? findMembership(schema) : null;
  if (schema && !membership) {
    notes.push(
      "no membership table found (a table with a unique uuid user column, a uuid tenant column and a role column); wrote a template",
    );
  }
  if (!schema || !membership) return { source: template(typesFile, roles), notes };

  const m = schema.tables.find((t) => t.name === membership.table) as TableInfo;
  const tenantFk = m.foreignKeys.find((fk) => fk.columns.length === 1 && fk.columns[0] === membership.tenant && fk.references[0] === "id");
  const target = tenantFk && schema.tables.find((t) => t.name === tenantFk.table);
  const tenantTable = target && findColumn(target, "id")?.type === "uuid" ? target.name : undefined;
  notes.push(`membership: ${membership.table} (${membership.user} -> ${membership.tenant}, ${membership.role})`);
  if (tenantTable) notes.push(`tenant table: ${tenantTable}`);
  if (options.roles?.length && roles === options.roles) notes.push(`roles from ${membership.table}.${membership.role}: ${roles.join(", ")}`);
  else notes.push(`roles: ${roles.join(", ")} (placeholders; ${membership.table}.${membership.role} lists no fixed values)`);

  const lines: string[] = [];
  const skipped: string[] = [];
  // The tenant table first, then the membership table, then the rest by name.
  const rank = (t: TableInfo) => (t.name === tenantTable ? 0 : t.name === membership.table ? 1 : 2);
  const ordered = [...schema.tables].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const t of ordered) {
    if (!IDENT.test(t.name)) {
      skipped.push(`${shown(t.name)}: the name needs quoting`);
      continue;
    }
    if (t.primaryKey.length !== 1 || t.primaryKey[0] !== "id") {
      skipped.push(`${t.name}: the primary key is not a single "id" column`);
      continue;
    }
    if (t.name === tenantTable) {
      lines.push(`    ${t.name}: table({ tenant: "id", read: { "*": true } }),`);
      continue;
    }
    const tenant = tenantColumn(t, membership.tenant);
    if (!tenant) {
      skipped.push(`${t.name}: no NOT NULL uuid tenant column`);
      continue;
    }
    const read = t.name === membership.table ? `{ "*": col(${JSON.stringify(membership.user)}).eq(claim.user) }` : `{ "*": true }`;
    lines.push(`    ${t.name}: table({ tenant: ${JSON.stringify(tenant)}, read: ${read} }),`);
  }
  for (const s of skipped) notes.push(`left out ${s}`);

  const source = `import { claim, col, definePolicy, table } from "samesight";
${typesComment("Regenerate after a schema migration", typesFile)}

// Drafted by \`samesight init\` from the local database. As written, every role reads
// every row of its own tenant, each user reads their own ${membership.table} row, and
// clients write nothing. Narrow the read rules and add write rules (write, insert,
// update, delete), then run \`samesight generate\`. \`samesight explain\` prints the result.

export default definePolicy<Database>({
  auth: "supabase",
  claims: {
    tenant: claim.uuid("tenant_id"),
    // Supabase reserves "role" for the Postgres role, so the app role is "app_role".
    role: claim.oneOf("app_role", [${roles.map((r) => JSON.stringify(r)).join(", ")}]),
  },
  membership: ${obj(membership)},
  tables: {
${lines.join("\n")}${skipped.length ? `\n${skipped.map((s) => `    // Left out: ${s}.`).join("\n")}` : ""}
  },
});
`;
  return { source, notes };
}

/** Values the role column can hold: enum labels, or the quoted literals of a CHECK on it. */
export async function roleValues(client: pg.Client, table: string, column: string): Promise<string[]> {
  const enumLabels = await client.query<{ label: string }>(
    `select e.enumlabel as label
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_enum e on e.enumtypid = a.atttypid
      where n.nspname = 'public' and c.relname = $1 and a.attname = $2
      order by e.enumsortorder`,
    [table, column],
  );
  if (enumLabels.rows.length) return enumLabels.rows.map((r) => r.label);
  const checks = await client.query<{ def: string }>(
    `select pg_get_constraintdef(k.oid) as def
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = $2
      where n.nspname = 'public' and c.relname = $1 and k.contype = 'c' and k.conkey = array[a.attnum]`,
    [table, column],
  );
  for (const { def } of checks.rows) {
    const values = [...def.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'"));
    if (values.length && values.every((v) => IDENT.test(v))) return [...new Set(values)];
  }
  return [];
}

/** The Database type import; a type-only import may name the .ts file under any module resolution. */
function typesComment(lead: string, typesFile: string): string {
  return `// ${lead}: supabase gen types typescript --local --schema public > ${typesFile}
import type { Database } from ${JSON.stringify(`./${typesFile}`)};`;
}

function template(typesFile: string, roles: string[]): string {
  return `import { claim, col, definePolicy, table } from "samesight";
${typesComment("Generate with", typesFile)}

export default definePolicy<Database>({
  auth: "supabase",
  claims: {
    tenant: claim.uuid("tenant_id"),
    // Supabase reserves "role" for the Postgres role, so the app role is "app_role".
    role: claim.oneOf("app_role", [${roles.map((r) => JSON.stringify(r)).join(", ")}]),
  },
  // Where the access token hook finds a signing-in user's tenant and role: one row per user.
  membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" },
  tables: {
    // Every table needs a single "id" primary key and a NOT NULL uuid tenant column.
    // Membership: table({ tenant: "tenantId", read: { ADMIN: true, MEMBER: col("userId").eq(claim.user) } }),
  },
});
`;
}

/** The tenant column of a table: the membership's tenant column name if it has it, else a tenant-like one. */
function tenantColumn(t: TableInfo, preferred: string): string | null {
  const ok = (name: string) => {
    const c = findColumn(t, name);
    return c !== undefined && c.type === "uuid" && !c.nullable;
  };
  if (ok(preferred)) return preferred;
  return t.columns.find((c) => TENANT_COLUMN.test(c.name) && ok(c.name))?.name ?? null;
}

/**
 * A name from the database, safe inside a // comment and on a terminal: a name that is not
 * an identifier is shown as an escaped string, so no newline, U+2028 or U+2029 can end the
 * comment and put a line of code in the policy file.
 */
function shown(name: string): string {
  if (IDENT.test(name)) return name;
  // JSON.stringify escapes C0 controls; U+2028, U+2029 and C1 controls are escaped here.
  return [...JSON.stringify(name)]
    .map((c) => {
      const code = c.charCodeAt(0);
      return code === 0x2028 || code === 0x2029 || (code >= 0x7f && code <= 0x9f) ? `\\u${code.toString(16).padStart(4, "0")}` : c;
    })
    .join("");
}

function obj(o: Record<string, string>): string {
  return `{ ${Object.entries(o)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ")} }`;
}
