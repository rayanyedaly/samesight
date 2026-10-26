/**
 * `samesight explain`: the compiled policy in plain words, for reviewing a policy change
 * without reading SQL. A matrix of who does what, then each table's rules, the columns
 * clients write and the columns each role never receives.
 */

import type { ConditionNode, Value } from "./policy.ts";
import type { IR, IRTable, Rule } from "./ir.ts";

const OPS = [
  ["read", "R"],
  ["insert", "I"],
  ["update", "U"],
  ["delete", "D"],
] as const;

export function explainPolicy(ir: IR, only?: string): string {
  const tables = only === undefined ? ir.tables : ir.tables.filter((t) => t.name === only);
  if (only !== undefined && tables.length === 0) {
    throw new Error(`no table "${only}" in the policy (it has ${ir.tables.map((t) => t.name).join(", ")})`);
  }
  const out: string[] = [];
  const shared = ir.tables.filter((t) => t.tenant === null).map((t) => t.name);
  out.push(
    `Every rule applies inside the user's own tenant: the "${ir.claims.tenant}" claim, set at sign-in from ${ir.membership.table}.${ir.membership.tenant}.`,
    ...(shared.length ? [`Except on ${shared.join(", ")}: shared by every tenant (tenant: null), read-only to clients.`] : []),
    `Roles come from the "${ir.claims.role}" claim (${ir.membership.table}.${ir.membership.role}): ${ir.claims.roles.join(", ")}.`,
    "",
  );

  // The matrix.
  const nameWidth = Math.max(5, ...tables.map((t) => t.name.length));
  const colWidth = Math.max(4, ...ir.claims.roles.map((r) => r.length));
  out.push("R I U D: every row of the tenant   r i u d: some rows   -: none");
  out.push(`${"".padEnd(nameWidth)}  ${ir.claims.roles.map((r) => r.padEnd(colWidth)).join("  ")}`.trimEnd());
  for (const t of tables) {
    const cells = ir.claims.roles.map((role) =>
      OPS.map(([op, letter]) => {
        const rule = t[op].get(role);
        return rule === undefined ? "-" : rule === true ? letter : letter.toLowerCase();
      }).join(""),
    );
    out.push(`${t.name.padEnd(nameWidth)}  ${cells.map((c) => c.padEnd(colWidth)).join("  ")}`.trimEnd());
  }

  for (const t of tables) out.push("", ...explainTable(ir, t));
  if (ir.rejectionReaders.length) {
    out.push("", `Refused writes: kept on the server for ${ir.rejectionReaders.join(", ")} to read (samesight."RejectedWrite").`);
  }
  if (ir.warnings.length) out.push("", ...ir.warnings.map((w) => `warning: ${w}`));
  return `${out.join("\n")}\n`;
}

function explainTable(ir: IR, t: IRTable): string[] {
  const lines = [
    t.tenant === null ? `${t.name} (shared: every tenant reads the same rows, and clients write none)`
    : t.tenant === "id" ? `${t.name} (the tenant table: each user sees their own tenant's row at most)`
    : `${t.name} (tenant column ${t.tenant})`,
  ];
  for (const [op] of OPS) {
    const rules = t[op];
    if (rules.size === 0) {
      lines.push(`  ${op}: nobody`);
      continue;
    }
    lines.push(`  ${op}:`);
    for (const [rule, roles] of groupByRule(rules)) lines.push(`    ${roles.join(", ")}: ${describeRule(rule, op)}`);
    const missing = ir.claims.roles.filter((r) => !rules.has(r));
    if (missing.length) lines.push(`    ${missing.join(", ")}: nothing`);
  }
  if (t.check) lines.push(`  every insert and update must have: ${describe(t.check)}`);
  if (t.appendOnly) {
    const parts = ["rows are never updated or deleted"];
    if (t.appendOnly.supersedes) parts.push(`a correction is a new row whose ${t.appendOnly.supersedes} names the row it replaces`);
    if (t.appendOnly.order) parts.push(`the server numbers rows in ${t.appendOnly.order}`);
    lines.push(`  append-only: ${parts.join("; ")}`);
  }
  if (t.insertColumns.length || t.updateColumns.length) {
    const insertOnly = t.insertColumns.filter((c) => !t.updateColumns.includes(c));
    const both = t.insertColumns.filter((c) => t.updateColumns.includes(c));
    const updateOnly = t.updateColumns.filter((c) => !t.insertColumns.includes(c));
    if (both.length) lines.push(`  clients write: ${both.join(", ")}`);
    if (insertOnly.length) lines.push(`  clients set on insert only: ${insertOnly.join(", ")}`);
    if (updateOnly.length) lines.push(`  clients change on update only: ${updateOnly.join(", ")}`);
  }
  const server = [...t.serverOwned];
  if (server.length && (t.insert.size || t.update.size)) {
    const notes = server.map((c) =>
      c === t.author ? `${c} (the signed-in user)` : c === t.touch ? `${c} (now(), on every update)` : c === t.tenant ? `${c} (from the token)` : c,
    );
    lines.push(`  the server sets: ${notes.join(", ")}`);
  }
  for (const [role, cols] of t.hide) {
    if (cols.length && t.read.has(role)) lines.push(`  never synced to ${role}: ${cols.join(", ")} (still readable over the REST API; RLS is per row)`);
  }
  return lines;
}

/** Roles that share an identical rule, in role order. */
function groupByRule(rules: Map<string, Rule>): [Rule, string[]][] {
  const groups = new Map<string, [Rule, string[]]>();
  for (const [role, rule] of rules) {
    const k = JSON.stringify(rule);
    const g = groups.get(k);
    if (g) g[1].push(role);
    else groups.set(k, [rule, [role]]);
  }
  return [...groups.values()];
}

function describeRule(rule: Rule, op: (typeof OPS)[number][0]): string {
  const rows = op === "insert" ? "new rows" : "rows";
  const when = op === "update" ? " (before and after the change)" : "";
  return rule === true ? `every ${op === "insert" ? "new " : ""}row` : `${rows} where ${describe(rule)}${when}`;
}

export function describe(node: ConditionNode, nested = false): string {
  switch (node.kind) {
    case "eq":
      return `${node.column} = ${value(node.value)}`;
    case "in":
      return node.values.length === 1 ? `${node.column} = ${value(node.values[0])}` : `${node.column} is one of ${node.values.map(value).join(", ")}`;
    case "isNull":
      return `${node.column} is ${node.negate ? "not " : ""}null`;
    case "inRows": {
      const where = node.rows.where ? ` where ${describe(node.rows.where, true)}` : "";
      return `${node.column} is the ${node.rows.column} of a ${node.rows.table} row the user can read${where}`;
    }
    case "via":
      return `the ${node.parent} row that ${node.column} points to is readable by the user`;
    case "raw":
      return `raw SQL (${node.rls}) / sync (${node.sync})`;
    case "and":
    case "or": {
      const text = node.items.map((i) => describe(i, true)).join(node.kind === "and" ? " and " : " or ");
      return nested ? `(${text})` : text;
    }
  }
}

function value(v: Value): string {
  if (typeof v === "object") return "the signed-in user";
  return typeof v === "string" ? v : String(v);
}
