/**
 * A best-effort reading of a project's SQL migrations, for lint's RLS rules: which public
 * tables end up with row level security enabled, and which policies they end up with.
 * Statements are applied in file order (Supabase names migrations by timestamp). Only
 * plain DDL is understood: RLS switched on or off in a function, a DO block or dynamic
 * SQL is not seen, so the rules built on this say what the migrations show, not what the
 * database holds. `samesight-verify audit` reads the database itself.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Located {
  file: string;
  line: number;
}

export interface Policy extends Located {
  name: string;
  /** all, select, insert, update or delete. */
  command: string;
  /** AS RESTRICTIVE: it can only narrow what permissive policies allow. */
  restrictive: boolean;
  /** Lowercased; "public" when the policy names none. */
  roles: string[];
  /** The USING and WITH CHECK expressions as written, outer parentheses removed. */
  using: string | null;
  check: string | null;
}

export interface Migrations {
  /** Tables whose RLS the migrations leave on, with where it was turned on. */
  rls: Map<string, Located>;
  /** Policies the migrations leave in place, per table. */
  policies: Map<string, Policy[]>;
}

/** Every `.sql` file in `dir`, in name order, read into one Migrations. */
export function readMigrations(dir: string): Migrations {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return applyMigrations(files.map((f) => ({ file: join(dir, f), sql: readFileSync(join(dir, f), "utf8") })));
}

export function applyMigrations(files: { file: string; sql: string }[]): Migrations {
  const out: Migrations = { rls: new Map(), policies: new Map() };
  for (const { file, sql } of files) {
    for (const s of statements(sql)) apply(out, s.text, { file, line: s.line });
  }
  return out;
}

const NAME = `(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const TABLE = String.raw`(?:(${NAME})\.)?(${NAME})`;

function apply(m: Migrations, text: string, at: Located): void {
  let x = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${TABLE}\s+(.*)$`, "is").exec(text);
  if (x) {
    const table = publicTable(x[1], x[2]);
    if (!table) return;
    for (const action of topLevelSplit(x[3] ?? "")) {
      const rls = /^(enable|disable)\s+row\s+level\s+security$/i.exec(action);
      if (rls) {
        if (rls[1]?.toLowerCase() === "enable") m.rls.set(table, at);
        else m.rls.delete(table);
      }
      const rename = new RegExp(String.raw`^rename\s+to\s+(${NAME})$`, "i").exec(action);
      if (rename) move(m, table, name(rename[1] as string));
      // Moved out of public: a later public table of that name starts afresh.
      const schema = new RegExp(String.raw`^set\s+schema\s+(${NAME})$`, "i").exec(action);
      if (schema && name(schema[1] as string) !== "public") {
        m.rls.delete(table);
        m.policies.delete(table);
      }
    }
    return;
  }
  x = new RegExp(String.raw`^create\s+policy\s+(${NAME})\s+on\s+${TABLE}(.*)$`, "is").exec(text);
  if (x) {
    const table = publicTable(x[2], x[3]);
    if (!table) return;
    const rest = x[4] ?? "";
    const head = beforeClauses(rest);
    const command = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(head)?.[1]?.toLowerCase() ?? "all";
    const policy: Policy = {
      ...at,
      name: name(x[1] as string),
      command,
      restrictive: /\bas\s+restrictive\b/i.test(head),
      roles: roles(head) ?? ["public"],
      using: clause(rest, "using"),
      check: clause(rest, "with check"),
    };
    m.policies.set(table, [...(m.policies.get(table) ?? []).filter((p) => p.name !== policy.name), policy]);
    return;
  }
  x = new RegExp(String.raw`^alter\s+policy\s+(${NAME})\s+on\s+${TABLE}(.*)$`, "is").exec(text);
  if (x) {
    const table = publicTable(x[2], x[3]);
    const old = name(x[1] as string);
    const policies = table ? (m.policies.get(table) ?? []) : [];
    const p = policies.find((p) => p.name === old);
    if (!table || !p) return;
    const rest = x[4] ?? "";
    const rename = new RegExp(String.raw`^\s*rename\s+to\s+(${NAME})\s*$`, "i").exec(rest);
    const changed: Policy = rename
      ? { ...p, name: name(rename[1] as string) }
      : { ...p, ...at, roles: roles(beforeClauses(rest)) ?? p.roles, using: clause(rest, "using") ?? p.using, check: clause(rest, "with check") ?? p.check };
    m.policies.set(table, [...policies.filter((q) => q !== p && q.name !== changed.name), changed]);
    return;
  }
  x = new RegExp(String.raw`^drop\s+policy\s+(?:if\s+exists\s+)?(${NAME})\s+on\s+${TABLE}`, "i").exec(text);
  if (x) {
    const table = publicTable(x[2], x[3]);
    if (table) m.policies.set(table, (m.policies.get(table) ?? []).filter((p) => p.name !== name(x?.[1] as string)));
    return;
  }
  x = new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?${TABLE}`, "i").exec(text);
  if (x) {
    const table = publicTable(x[1], x[2]);
    if (table) {
      m.rls.delete(table);
      m.policies.delete(table);
    }
  }
}

/** A table renamed: its RLS and policies go with it. */
function move(m: Migrations, from: string, to: string): void {
  const rls = m.rls.get(from);
  m.rls.delete(from);
  if (rls) m.rls.set(to, rls);
  const policies = m.policies.get(from);
  m.policies.delete(from);
  if (policies) m.policies.set(to, policies);
}

/** A policy statement up to its USING or WITH CHECK, where AS, FOR and TO are read. */
const beforeClauses = (rest: string) => rest.split(/\busing\s*\(|\bwith\s+check\s*\(/i)[0] ?? "";

/** The roles after TO, lowercased; undefined when there is no TO. */
function roles(head: string): string[] | undefined {
  const to = /\bto\s+(.+)$/is.exec(head)?.[1];
  return to ? to.split(",").map((r) => name(r.trim())) : undefined;
}

/** Parts of `text` split on commas outside parentheses and strings. */
function topLevelSplit(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      i = end === -1 ? text.length : end;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** The table's name when it is in public (named or by default), else null. */
function publicTable(schema: string | undefined, table: string | undefined): string | null {
  if (!table || (schema !== undefined && name(schema) !== "public")) return null;
  return name(table);
}

/** An identifier as Postgres resolves it: quoted kept as written, unquoted lowercased. */
function name(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();
}

/** The parenthesised expression after `keyword`, outer parentheses removed; null if absent. */
function clause(text: string, keyword: string): string | null {
  const m = new RegExp(String.raw`\b${keyword.replace(" ", String.raw`\s+`)}\s*\(`, "i").exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") i = text.indexOf("'", i + 1) === -1 ? text.length : text.indexOf("'", i + 1);
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(m.index + m[0].length, i).trim();
  }
  return null;
}

/**
 * The statements of a SQL file, comments removed and whitespace collapsed, each with the
 * line it starts on. Semicolons inside strings, quoted names and dollar-quoted bodies do
 * not split.
 */
export function statements(sql: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let text = "";
  let start = 1;
  let line = 1;
  const flush = () => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) out.push({ text: t, line: start });
    text = "";
  };
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i] as string;
    if (!text.trim() && !/\s/.test(ch)) start = line;
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      line += countLines(sql.slice(i, stop));
      text += " ";
      i = stop;
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
    const quote = ch === "'" || ch === '"' ? ch : dollar?.[0];
    if (quote) {
      let end = sql.indexOf(quote, i + quote.length);
      // A doubled quote ('' or "") continues the string.
      while (end !== -1 && quote.length === 1 && sql[end + 1] === quote) end = sql.indexOf(quote, end + 2);
      const stop = end === -1 ? sql.length : end + quote.length;
      const body = sql.slice(i, stop);
      line += countLines(body);
      text += body;
      i = stop;
      continue;
    }
    if (ch === "\n") line++;
    if (ch === ";") flush();
    else text += ch;
    i++;
  }
  flush();
  return out;
}

const countLines = (s: string) => s.split("\n").length - 1;
