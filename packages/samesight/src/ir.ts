/**
 * The intermediate representation both emitters read, so RLS and sync streams come
 * from the same tree. Building it validates the policy against the database schema
 * and rejects anything one side cannot express, naming the offending rule.
 */

import type { ConditionNode, Literal, Policy, RoleRules, RowsOf, TableSpec } from "./policy.ts";
import { type ColumnInfo, findColumn, findTable, type SchemaInfo, type TableInfo } from "./schema.ts";

/** A rule for one role and operation: every row (`true`) or the rows matching a condition. */
export type Rule = true | ConditionNode;

export interface IRTable {
  name: string;
  columns: ColumnInfo[];
  /** The tenant column; `"id"` for the tenant table itself. */
  tenant: string;
  /** Per role. A role missing from the map has no access for that operation. */
  read: Map<string, Rule>;
  insert: Map<string, Rule>;
  update: Map<string, Rule>;
  delete: Map<string, Rule>;
  check?: ConditionNode;
  /** Per role: columns left out of the sync projection. */
  hide: Map<string, string[]>;
  /** Columns clients never write: explicit ones, the tenant, identities, order, author, touch. */
  serverOwned: string[];
  /** Columns a client may set on insert, in table order. */
  insertColumns: string[];
  /** Columns a client may change on update, in table order (empty without an update rule). */
  updateColumns: string[];
  author?: string;
  touch?: string;
  appendOnly?: { supersedes?: string; order?: string };
  /** Identity columns: their sequences are revoked from clients. */
  identityColumns: string[];
  /**
   * Columns a composite foreign key (tenant, column) -> parent (tenant, key) ties to a
   * parent row in the same tenant. A via over one of them to a parent the role reads
   * entirely needs no subquery in a stream: the tenant gate already says it.
   */
  tenantLinked: { column: string; parent: string; key: string }[];
}

export interface IR {
  claims: { tenant: string; role: string; roles: string[] };
  membership: { table: string; user: string; tenant: string; role: string };
  /** The table whose rows are tenants (`tenant: "id"`), if the policy has one. */
  tenantTable?: string;
  tables: IRTable[];
  /** Roles that read samesight."RejectedWrite" for their tenant. */
  rejectionReaders: string[];
  warnings: string[];
}

export class CompileError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`The policy does not compile:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CompileError";
    this.problems = problems;
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLAIM_NAME = /^[a-z_][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Claims Supabase Auth and PostgREST own; the access token hook must not overwrite them.
const RESERVED_CLAIMS = new Set(
  "role sub aud exp iat iss nbf jti email phone app_metadata user_metadata is_anonymous session_id aal amr".split(" "),
);
// Sync buckets cannot re-evaluate on a clock, so time-relative raw rules are refused. A
// heuristic: the verifier is what proves a raw rule agrees on both sides.
const CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|age|random)\s*\(|"now"\s*\(|'(now|today|tomorrow|yesterday)'|\bcurrent_(date|time|timestamp)\b|\blocaltime(stamp)?\b/i;
const CONDITION_KINDS = new Set(["eq", "in", "inRows", "isNull", "via", "and", "or", "raw"]);

export function buildIR(policy: Policy, schema: SchemaInfo): IR {
  const spec = policy.spec;
  const problems: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string) => problems.push(msg);

  const roles = [...spec.claims.role.values];
  if (roles.length === 0) fail("claims.role lists no roles");
  for (const r of roles) if (!IDENT.test(r)) fail(`claims.role: role "${r}" must be letters, digits and underscores`);
  if (new Set(roles).size !== roles.length) fail("claims.role lists a role twice");
  // Roles name the sync streams, lowercased.
  for (const [key, c] of [
    ["tenant", spec.claims.tenant],
    ["role", spec.claims.role],
  ] as const) {
    if (!CLAIM_NAME.test(c.name)) fail(`claims.${key}: claim name "${c.name}" must be lowercase letters, digits and underscores`);
    else if (RESERVED_CLAIMS.has(c.name)) fail(`claims.${key}: "${c.name}" is a claim Supabase sets itself; pick another name (e.g. app_${c.name})`);
  }
  if (spec.claims.tenant.name === spec.claims.role.name) fail("claims: tenant and role use the same claim name");
  if (new Set(roles).size === roles.length && new Set(roles.map(snake)).size !== roles.length) {
    fail("claims.role: two roles name the same sync stream (they differ only in case or underscores)");
  }
  const rejectionReaders = Array.isArray(spec.rejectedWrites?.read) ? [...spec.rejectedWrites.read] : [];
  if (spec.rejectedWrites && !Array.isArray(spec.rejectedWrites.read)) fail("rejectedWrites.read: a list of roles");
  else for (const r of rejectionReaders) if (!roles.includes(r)) fail(`rejectedWrites.read: unknown role "${r}"`);

  // Membership, read by the access token hook.
  const m = spec.membership;
  if (!IDENT.test(m.table)) fail(`membership.table: "${m.table}" must be letters, digits and underscores`);
  const membershipTable = findTable(schema, m.table);
  if (!membershipTable) fail(`membership.table: no table "${m.table}" in the database`);
  else {
    for (const key of ["user", "tenant", "role"] as const) {
      if (!findColumn(membershipTable, m[key])) fail(`membership.${key}: no column "${m[key]}" in "${m.table}"`);
      else if (!IDENT.test(m[key])) fail(`membership.${key}: "${m[key]}" must be letters, digits and underscores`);
    }
    if (findColumn(membershipTable, m.user) && !membershipTable.uniqueColumns.includes(m.user)) {
      fail(`membership.user: "${m.user}" must be unique (one tenant per user); the token hook would pick one at random`);
    }
  }

  const entries = Object.entries(spec.tables).filter((e): e is [string, TableSpec] => e[1] !== undefined);
  if (entries.length === 0) fail("tables: the policy covers no tables");
  const policyTables = new Set(entries.map(([name]) => name));

  const tables: IRTable[] = [];
  for (const [name, t] of entries) {
    const info = findTable(schema, name);
    if (!info) {
      fail(`${name}: no table "${name}" in the database (run \`supabase start\` and apply the migrations first)`);
      continue;
    }
    const built = buildTable(name, t, info);
    if (built) tables.push(built);
  }

  // Cross-table checks: read rules that reach a parent through via.
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables) {
    for (const fk of findTable(schema, t.name)?.foreignKeys ?? []) {
      const parent = byName.get(fk.table);
      const i = fk.columns.indexOf(t.tenant);
      if (!parent || fk.columns.length !== 2 || i === -1 || fk.references[i] !== parent.tenant) continue;
      // A NULL column skips the foreign key check (MATCH SIMPLE), and RLS hides such a row.
      if (findColumn(findTable(schema, t.name) as TableInfo, fk.columns[1 - i])?.nullable !== false) continue;
      t.tenantLinked.push({ column: fk.columns[1 - i], parent: parent.name, key: fk.references[1 - i] });
    }
  }
  for (const t of tables) {
    for (const [role, rule] of t.read) {
      if (rule === true) continue;
      for (const v of vias(rule)) {
        const parent = byName.get(v.parent);
        if (!parent) continue; // reported in buildTable
        const parentRule = parent.read.get(role);
        if (parentRule === undefined) {
          fail(`${t.name}.read.${role}: reads through via("${v.column}", "${v.parent}"), but ${role} has no read rule on "${v.parent}"`);
        } else if (parentRule !== true && subqueries(parentRule).length > 0) {
          fail(
            `${t.name}.read.${role}: via("${v.column}", "${v.parent}") reaches a parent whose own ${role} rule uses via or rowsOf; sync streams cannot nest them`,
          );
        }
        const childInfo = findTable(schema, t.name);
        if (childInfo && !childInfo.indexedColumns.includes(v.column) && childInfo.primaryKey[0] !== v.column) {
          warnings.push(`${t.name}: via("${v.column}", "${v.parent}") has no index on "${v.column}"; RLS checks will scan`);
        }
      }
      // rowsOf in a read rule: the target's rows this role reads, so the stream repeats the
      // target's rule for the role in a CTE, as for via.
      for (const r of subqueries(rule)) {
        if (r.kind !== "inRows") continue;
        const target = byName.get(r.rows.table);
        if (!target) continue; // reported in checkCondition
        const targetRule = target.read.get(role);
        const call = `rowsOf("${r.rows.table}", "${r.rows.column}")`;
        if (targetRule === undefined) {
          fail(`${t.name}.read.${role}: reads through ${call}, but ${role} has no read rule on "${r.rows.table}"`);
        } else if (targetRule !== true && subqueries(targetRule).length > 0) {
          fail(`${t.name}.read.${role}: ${call} reaches a table whose own ${role} rule uses via or rowsOf; sync streams cannot nest them`);
        }
        const targetInfo = findTable(schema, r.rows.table);
        if (r.rows.where && targetInfo) {
          for (const c of conditionColumns(r.rows.where)) {
            if (!targetInfo.indexedColumns.includes(c) && targetInfo.primaryKey[0] !== c) {
              warnings.push(`${t.name}: ${call} filters on "${r.rows.table}.${c}", which has no index; RLS checks will scan`);
            }
          }
        }
      }
    }
  }

  const membershipSpec = byName.get(m.table);
  if (membershipTable && policyTables.has(m.table) === false) {
    fail(`membership.table: "${m.table}" must be a table in this policy, or it keeps Supabase's default grants and no RLS`);
  } else if (membershipSpec && membershipSpec.read.size === 0) {
    fail(`membership.table: "${m.table}" needs a read rule (each user at least reads their own membership)`);
  }
  if (tables.length > 0 && !tables.some((t) => t.read.size > 0)) fail("tables: no table has a read rule, so nothing syncs");

  // Postgres refuses a policy that reaches its own table through other tables' policies,
  // whatever the role, so cycles of via and rowsOf across all rules are refused here.
  const edges = new Map(tables.map((t) => [t.name, new Set<string>()]));
  for (const t of tables) {
    for (const rules of [t.read, t.insert, t.update, t.delete]) {
      for (const rule of rules.values()) if (rule !== true) for (const target of references(rule)) edges.get(t.name)?.add(target);
    }
    if (t.check) for (const target of references(t.check)) edges.get(t.name)?.add(target);
  }
  const cycle = findCycle(edges);
  if (cycle) fail(`tables: ${cycle.join(" -> ")} reach each other through via or rowsOf; Postgres refuses recursive policies`);

  const tenantTables = tables.filter((t) => t.tenant === "id");
  if (tenantTables.length > 1) fail(`tables: ${tenantTables.map((t) => t.name).join(" and ")} both use tenant: "id"`);

  if (problems.length > 0) throw new CompileError(problems);
  return {
    claims: { tenant: spec.claims.tenant.name, role: spec.claims.role.name, roles },
    membership: { ...m },
    tenantTable: tenantTables[0]?.name,
    tables,
    rejectionReaders,
    warnings: unique(warnings),
  };

  // ---------------------------------------------------------------------------------

  function buildTable(name: string, t: TableSpec, info: TableInfo): IRTable | null {
    const before = problems.length;
    if (!IDENT.test(name)) fail(`${name}: table names must be letters, digits and underscores`);
    else if (name.length > 48) fail(`${name}: table names over 48 characters would truncate generated policy and trigger names`);
    const column = (path: string, c: string | undefined) => {
      if (c === undefined) return;
      if (!findColumn(info, c)) fail(`${path}: no column "${c}" in "${name}"`);
      else if (!IDENT.test(c)) fail(`${path}: column "${c}" must be letters, digits and underscores`);
    };

    if (info.primaryKey.length !== 1 || info.primaryKey[0] !== "id") {
      fail(`${name}: the primary key must be a single "id" column (PowerSync identifies rows by id)`);
    }

    // Tenant.
    const tenantCol = findColumn(info, t.tenant);
    if (!tenantCol) fail(`${name}.tenant: no column "${t.tenant}" in "${name}"`);
    else if (tenantCol.type !== "uuid") fail(`${name}.tenant: "${t.tenant}" must be uuid, not ${tenantCol.type}`);
    else if (tenantCol.nullable) fail(`${name}.tenant: "${t.tenant}" must be NOT NULL; a row without a tenant has no owner to scope it to`);

    // Rules.
    const read = mergeRules(`${name}.read`, [t.read]);
    const insert = mergeRules(`${name}.insert`, [t.write, t.insert]);
    const update = mergeRules(`${name}.update`, [t.write, t.update]);
    const del = mergeRules(`${name}.delete`, [t.write, t.delete]);
    for (const [op, rules] of [
      ["read", read],
      ["insert", insert],
      ["update", update],
      ["delete", del],
    ] as const) {
      for (const [role, rule] of rules) {
        if (rule !== true) checkCondition(`${name}.${op}.${role}`, rule, info, op === "read");
      }
    }
    for (const [role, rule] of read) if (rule !== true) checkViaPlacement(`${name}.read.${role}`, rule);
    if (t.check) checkCondition(`${name}.check`, t.check, info, false);

    const writable = insert.size + update.size + del.size > 0;
    // Upserts, PATCH and replay checks read the row back under the caller's SELECT policy.
    for (const role of new Set([...insert.keys(), ...update.keys(), ...del.keys()])) {
      if (!read.has(role)) fail(`${name}: ${role} writes "${name}" but has no read rule on it; writes read the row back`);
    }
    if (t.tenant === "id" && writable) fail(`${name}: the tenant table (tenant: "id") cannot be written by clients`);

    // Append-only.
    if (t.appendOnly) {
      if (update.size > 0 || del.size > 0) {
        fail(`${name}: append-only tables take insert rules only, not update, delete or write`);
      }
      if (t.touch) fail(`${name}: append-only tables are never updated, so touch does not apply`);
      column(`${name}.appendOnly.supersedes`, t.appendOnly.supersedes);
      column(`${name}.appendOnly.order`, t.appendOnly.order);
      const order = t.appendOnly.order ? findColumn(info, t.appendOnly.order) : undefined;
      if (order && !order.identity && order.default === null) {
        fail(`${name}.appendOnly.order: "${order.name}" must be assigned by the server (an identity column or a default)`);
      }
    }

    // Column lists.
    column(`${name}.author`, t.author);
    const author = t.author ? findColumn(info, t.author) : undefined;
    if (author && !/\bauth\.uid\(\)/.test(author.default ?? "")) {
      fail(`${name}.author: "${author.name}" needs the column default auth.uid(); inserts are checked against it`);
    }
    column(`${name}.touch`, t.touch);
    const touch = t.touch ? findColumn(info, t.touch) : undefined;
    if (touch && touch.type !== "timestamp with time zone") fail(`${name}.touch: "${touch.name}" must be timestamptz`);
    for (const c of t.serverOwned ?? []) column(`${name}.serverOwned`, c);
    for (const c of t.immutable ?? []) column(`${name}.immutable`, c);
    // "*" hides from every role, on top of any per-role list.
    const hide = new Map<string, string[]>();
    for (const [key, cols] of Object.entries(t.hide ?? {})) {
      if (key !== "*" && !roles.includes(key)) fail(`${name}.hide: unknown role "${key}"`);
      if (!Array.isArray(cols)) {
        fail(`${name}.hide.${key}: a list of columns`);
        continue;
      }
      for (const c of cols) {
        column(`${name}.hide.${key}`, c);
        if (c === "id" || c === t.tenant) fail(`${name}.hide.${key}: "${c}" cannot be hidden`);
      }
      for (const role of key === "*" ? roles : [key]) hide.set(role, unique([...(hide.get(role) ?? []), ...cols]));
    }

    const identityColumns = info.columns.filter((c) => c.identity).map((c) => c.name);
    const serverOwned = unique([
      ...(t.serverOwned ?? []),
      t.tenant,
      ...identityColumns,
      ...info.columns.filter((c) => c.generated).map((c) => c.name),
      ...(t.appendOnly?.order ? [t.appendOnly.order] : []),
      ...(t.author ? [t.author] : []),
      ...(t.touch ? [t.touch] : []),
    ]).filter((c) => c !== "id");
    if (writable) {
      for (const c of info.columns) {
        if (serverOwned.includes(c.name) && c.name !== t.tenant && !c.nullable && c.default === null && !c.identity && !c.generated) {
          fail(`${name}: server-owned column "${c.name}" is NOT NULL without a default, so client inserts would fail`);
        }
      }
    }
    const clientColumns = info.columns.map((c) => c.name).filter((c) => c !== "id" && !serverOwned.includes(c));
    const insertColumns = insert.size > 0 ? clientColumns : [];
    const immutable = new Set(t.immutable ?? []);
    const updateColumns = update.size > 0 ? clientColumns.filter((c) => !immutable.has(c)) : [];

    // A role that cannot see a column but can update the row would write it back as null.
    for (const [role, cols] of hide) {
      const lost = update.has(role) ? cols.filter((c) => updateColumns.includes(c)) : [];
      if (lost.length) fail(`${name}.hide.${role}: ${role} updates this table, so hidden columns must be immutable or server-owned (${lost.join(", ")})`);
    }

    if (problems.length > before) return null;
    return {
      name,
      columns: info.columns,
      tenant: t.tenant,
      read,
      insert,
      update,
      delete: del,
      check: t.check ? normalize(t.check) : undefined,
      hide,
      serverOwned,
      insertColumns,
      updateColumns,
      author: t.author,
      touch: t.touch,
      appendOnly: t.appendOnly ? { ...t.appendOnly } : undefined,
      identityColumns,
      tenantLinked: [],
    };
  }

  /** Per role, the OR of every rule that applies to it ("*" and its own, across sources). */
  function mergeRules(path: string, sources: (RoleRules<string> | undefined)[]): Map<string, Rule> {
    const perRole = new Map<string, Rule[]>();
    for (const source of sources) {
      for (const [key, rule] of Object.entries(source ?? {})) {
        if (key !== "*" && !roles.includes(key)) {
          fail(`${path}: unknown role "${key}" (claims.role lists ${roles.join(", ")})`);
          continue;
        }
        // The policy file is user code: refuse anything that is not `true` or a condition.
        if (rule !== true && !isCondition(rule)) {
          fail(`${path}.${key}: a rule is \`true\` or a condition, not ${JSON.stringify(rule) ?? String(rule)}`);
          continue;
        }
        for (const role of key === "*" ? roles : [key]) {
          perRole.set(role, [...(perRole.get(role) ?? []), rule]);
        }
      }
    }
    const merged = new Map<string, Rule>();
    for (const role of roles) {
      const rules = perRole.get(role);
      if (!rules) continue;
      merged.set(role, rules.some((r) => r === true) ? true : normalize({ kind: "or", items: rules as ConditionNode[] }));
    }
    return merged;
  }

  function checkCondition(path: string, node: ConditionNode, info: TableInfo, isRead: boolean): void {
    if (!isCondition(node)) {
      fail(`${path}: not a condition: ${JSON.stringify(node) ?? String(node)}`);
      return;
    }
    const has = (c: string): ColumnInfo | undefined => {
      const found = findColumn(info, c);
      if (!found) fail(`${path}: no column "${c}" in "${info.name}"`);
      else if (!IDENT.test(c)) fail(`${path}: column "${c}" must be letters, digits and underscores`);
      return found;
    };
    switch (node.kind) {
      case "eq": {
        const c = has(node.column);
        if (typeof node.value === "object" && node.value !== null && (node.value as { kind?: unknown }).kind === "user") {
          if (c && c.type !== "uuid") fail(`${path}: "${node.column}" is ${c.type}; claim.user compares with a uuid column`);
        } else literal(path, node.value as Literal, c, isRead);
        return;
      }
      case "in": {
        const c = has(node.column);
        if (!Array.isArray(node.values) || node.values.length === 0) {
          fail(`${path}: col("${node.column}").in([]) matches nothing; remove the rule instead`);
          return;
        }
        for (const v of node.values) literal(path, v, c, isRead);
        return;
      }
      case "isNull":
        has(node.column);
        return;
      case "inRows":
        has(node.column);
        rows(path, node.rows, isRead);
        return;
      case "via": {
        has(node.column);
        if (!policyTables.has(node.parent)) {
          fail(`${path}: via("${node.column}", "${node.parent}"): "${node.parent}" is not a table in this policy`);
          return;
        }
        const parent = findTable(schema, node.parent);
        if (parent && !findColumn(parent, node.parentKey)) fail(`${path}: via key "${node.parentKey}" is not a column of "${node.parent}"`);
        else if (!IDENT.test(node.parentKey)) fail(`${path}: via key "${node.parentKey}" must be letters, digits and underscores`);
        return;
      }
      case "and":
      case "or":
        if (!Array.isArray(node.items) || node.items.length === 0) {
          fail(`${path}: empty ${node.kind}()`);
          return;
        }
        for (const item of node.items) checkCondition(path, item, info, isRead);
        return;
      case "raw":
        if (typeof node.rls !== "string" || typeof node.sync !== "string" || !node.rls.trim() || !node.sync.trim()) {
          fail(`${path}: raw rule needs both rls and sync`);
          return;
        }
        if (/--|\/\*|#|;/.test(node.rls) || /--|\/\*|#|;/.test(node.sync)) {
          fail(`${path}: raw rules cannot contain comments (--, /*, #) or ";"`);
        }
        // Each side is wrapped in parentheses and ANDed with the tenant and role gates; an
        // unbalanced side like "x) or (true" would close that wrapper and escape the gates.
        // $ (dollar quoting) and \ (E'' escapes) would let a quote end where the scan below
        // does not see it end, so neither is allowed.
        if (/[$\\]/.test(node.rls) || /[$\\]/.test(node.sync)) {
          fail(`${path}: raw rules cannot contain $ or \\ (dollar quoting, escape strings)`);
        } else if (!balanced(node.rls) || !balanced(node.sync)) {
          fail(`${path}: raw rules need balanced parentheses and closed quotes`);
        }
        if (CLOCK.test(node.rls) || CLOCK.test(node.sync)) {
          fail(`${path}: raw rule depends on the clock; sync buckets cannot re-evaluate on time, so scope by status instead`);
        }
        return;
      default: {
        const unknown: never = node;
        fail(`${path}: unknown condition ${JSON.stringify(unknown)}`);
      }
    }
  }

  /**
   * Read rules carry at most one via or rowsOf, alone or as a term of a top-level and():
   * streams take a CTE IN only there.
   */
  function checkViaPlacement(path: string, rule: ConditionNode): void {
    const all = subqueries(rule);
    if (all.length === 0) return;
    const isSub = (n: ConditionNode) => n.kind === "via" || n.kind === "inRows";
    const top = isSub(rule) ? [rule] : rule.kind === "and" ? rule.items.filter(isSub) : [];
    if (all.length !== top.length) {
      fail(
        `${path}: via and rowsOf must stand alone or be a term of a top-level and(); sync streams cannot put them under or() (rules for "*" and for a role are ORed together)`,
      );
    } else if (all.length > 1) fail(`${path}: one via or rowsOf per read rule`);
  }

  function rows(path: string, r: RowsOf, isRead: boolean): void {
    // The subquery runs under the caller's RLS on the target; only policy tables are
    // tenant-scoped by this policy, so only they may be the target.
    if (!policyTables.has(r.table)) {
      fail(`${path}: rowsOf("${r.table}", ...): "${r.table}" is not a table in this policy, so its rows are not tenant-scoped`);
      return;
    }
    const target = findTable(schema, r.table);
    if (!target) return; // reported with the table
    if (!findColumn(target, r.column)) fail(`${path}: rowsOf: no column "${r.column}" in "${r.table}"`);
    else if (!IDENT.test(r.column)) fail(`${path}: rowsOf: column "${r.column}" must be letters, digits and underscores`);
    if (r.where) {
      checkCondition(`${path} (rowsOf ${r.table})`, r.where, target, isRead);
      // The where goes into the stream's CTE, which cannot hold another subquery.
      if (isRead && subqueries(r.where).length > 0) fail(`${path}: rowsOf("${r.table}", ...) in a read rule cannot filter with via or rowsOf`);
    }
  }

  /**
   * A literal must be safe inside '...' in SQL and YAML, and its type must match the
   * column: Postgres casts a mismatch, but PowerSync compares replicated values as they
   * are, and the two sides would disagree.
   */
  function literal(path: string, v: Literal, c: ColumnInfo | undefined, isRead: boolean): void {
    const show = JSON.stringify(v) ?? String(v);
    if (typeof v === "string") {
      if (/['\\#]/.test(v) || [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\u2028" || ch === "\u2029")) {
        fail(`${path}: the literal ${show} contains a quote, backslash, # or control character`);
        return;
      }
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        fail(`${path}: ${v} is not a finite number`);
        return;
      }
    } else if (typeof v !== "boolean") {
      fail(`${path}: ${show} is not a string, number or boolean`);
      return;
    }
    if (!c) return;
    const kind = typeKind(c.type);
    const want =
      kind === "number" ? typeof v === "number" && (!/int/.test(c.type) || Number.isInteger(v))
      : kind === "uuid" ? typeof v === "string" && UUID.test(v)
      : kind === "boolean" ? typeof v === "boolean" && !isRead
      : kind === "time" || kind === "exact" ? false
      : typeof v === "string";
    if (!want) {
      const hint =
        kind === "uuid" ? "a lowercase canonical uuid string"
        : kind === "boolean" ? (isRead ? "nothing in a read rule (PowerSync syncs booleans as 0/1; use raw)" : "a boolean")
        : kind === "time" ? "no literal (time comparisons differ between Postgres and PowerSync; use a status column)"
        : kind === "exact" ? "no literal (PowerSync syncs exact numerics as text, so comparisons differ; use raw)"
        : kind === "number" ? (/int/.test(c.type) ? "an integer" : "a number")
        : "a string";
      fail(`${path}: ${show} does not fit "${c.name}" (${c.type}); it takes ${hint}`);
    }
  }
}

/** Flattens nested and/or of the same kind and unwraps single-item groups. */
export function normalize(node: ConditionNode): ConditionNode {
  if (node.kind !== "and" && node.kind !== "or") return node;
  const items: ConditionNode[] = [];
  for (const item of node.items.map(normalize)) {
    if (item.kind === node.kind) items.push(...item.items);
    else items.push(item);
  }
  return items.length === 1 ? items[0] : { kind: node.kind, items };
}

/** Tables a condition reads through: via parents and rowsOf targets. */
function references(node: ConditionNode): string[] {
  switch (node.kind) {
    case "via":
      return [node.parent];
    case "inRows":
      return [node.rows.table, ...(node.rows.where ? references(node.rows.where) : [])];
    case "and":
    case "or":
      return node.items.flatMap(references);
    default:
      return [];
  }
}

function findCycle(edges: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === "done") return null;
    if (state.get(n) === "open") return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, "open");
    stack.push(n);
    for (const next of edges.get(n) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(n, "done");
    return null;
  };
  for (const n of edges.keys()) {
    const found = visit(n);
    if (found) return found;
  }
  return null;
}

/** "Inspection" -> "inspection", "SiteVisit" -> "site_visit": stream and CTE names. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toLowerCase();
}

/** Every via and rowsOf in a condition, not counting those inside a rowsOf's where. */
export function subqueries(node: ConditionNode): Extract<ConditionNode, { kind: "via" | "inRows" }>[] {
  if (node.kind === "via" || node.kind === "inRows") return [node];
  if (node.kind === "and" || node.kind === "or") return node.items.flatMap(subqueries);
  return [];
}

/** The columns a condition compares, for index warnings. */
function conditionColumns(node: ConditionNode): string[] {
  if (node.kind === "and" || node.kind === "or") return node.items.flatMap(conditionColumns);
  return node.kind === "raw" ? [] : [node.column];
}

/** Every via in a condition. */
export function vias(node: ConditionNode): Extract<ConditionNode, { kind: "via" }>[] {
  if (node.kind === "via") return [node];
  if (node.kind === "and" || node.kind === "or") return node.items.flatMap(vias);
  return [];
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Structurally a condition: a known kind, with well-formed groups and rowsOf all the way down. */
function isCondition(v: unknown): v is ConditionNode {
  if (typeof v !== "object" || v === null) return false;
  const node = v as { kind?: unknown; items?: unknown; rows?: unknown; column?: unknown };
  if (!CONDITION_KINDS.has(node.kind as string)) return false;
  if (node.kind === "and" || node.kind === "or") return Array.isArray(node.items) && node.items.every(isCondition);
  if (node.kind !== "raw" && typeof node.column !== "string") return false;
  if (node.kind === "inRows") {
    const rows = node.rows as { kind?: unknown; table?: unknown; column?: unknown; where?: unknown } | null;
    return (
      typeof rows === "object" && rows !== null && rows.kind === "rows" && typeof rows.table === "string" &&
      typeof rows.column === "string" && (rows.where === undefined || isCondition(rows.where))
    );
  }
  return true;
}

function typeKind(type: string): "number" | "exact" | "uuid" | "boolean" | "time" | "text" {
  if (/^(smallint|integer|bigint|real|double precision)\b/.test(type)) return "number";
  if (/^(numeric|decimal|money)\b/.test(type)) return "exact";
  if (type === "uuid") return "uuid";
  if (type === "boolean") return "boolean";
  if (/^(timestamp|date|time|interval)\b/.test(type)) return "time";
  return "text";
}

/** Parentheses balance outside string literals and quoted identifiers, and every quote closes. */
function balanced(sql: string): boolean {
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = sql.indexOf(ch, i + 1);
      if (end === -1) return false;
      i = end; // A doubled quote ('') reopens at the next character, which is the same as skipping it.
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}
