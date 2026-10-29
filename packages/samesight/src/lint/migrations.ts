/**
 * A best-effort reading of a project's SQL migrations, for lint: which public tables they
 * create and with which columns, which public tables end up with row level security
 * enabled, and which policies they end up with. Statements are applied in file order
 * (Supabase names migrations by timestamp). Only plain DDL is understood: a table or its
 * RLS changed in a function, a DO block or dynamic SQL is not seen, so the rules built on
 * this say what the migrations show, not what the database holds. `samesight-verify audit`
 * reads the database itself.
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

export interface ColumnDef {
  name: string;
  /** The type as written, lowercased (quoted names aside) and with whitespace collapsed: "text", "timestamp with time zone", "uuid", "varchar(255)", "text[]". */
  type: string;
  /** COMMENT ON COLUMN text, when set; whitespace in it is collapsed. */
  comment?: string;
}

/** A public table as the migrations define it, located where it was created. */
export interface TableDef extends Located {
  /** In definition order; ADD COLUMN appends. */
  columns: ColumnDef[];
  /** Primary key columns, from an inline PRIMARY KEY or a table constraint. */
  primaryKey: string[];
  /** Columns that reference auth.users (inline REFERENCES, a table FOREIGN KEY, or ALTER TABLE ADD CONSTRAINT ... FOREIGN KEY). */
  userColumns: string[];
  /** False when the definition is not fully known here: LIKE, INHERITS, PARTITION OF, OF type, CREATE TABLE ... AS. */
  complete: boolean;
}

export interface Migrations {
  /** Tables whose RLS the migrations leave on, with where it was turned on. */
  rls: Map<string, Located>;
  /** Policies the migrations leave in place, per table. */
  policies: Map<string, Policy[]>;
  /** Public tables the migrations create and leave in place, with their columns. */
  tables: Map<string, TableDef>;
}

/** Every `.sql` file in `dir`, in name order, read into one Migrations. */
export function readMigrations(dir: string): Migrations {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return applyMigrations(files.map((f) => ({ file: join(dir, f), sql: readFileSync(join(dir, f), "utf8") })));
}

export function applyMigrations(files: { file: string; sql: string }[]): Migrations {
  const out: Migrations = { rls: new Map(), policies: new Map(), tables: new Map() };
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
      if (schema && name(schema[1] as string) !== "public") forget(m, table);
      const def = m.tables.get(table);
      if (def) alterColumns(def, action, table, indexesOf(m));
    }
    return;
  }
  x = new RegExp(String.raw`^create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${NAME})\s+on\s+(?:only\s+)?${TABLE}\s*(?:using\s+\w+\s*)?(\(.*)$`, "is").exec(text);
  if (x) {
    const table = publicTable(x[2], x[3]);
    const def = table ? m.tables.get(table) : undefined;
    const list = parenthesised(x[4] ?? "");
    // Only plain columns: an expression or a partial index cannot back a primary key.
    const plain = list && topLevelSplit(list[0]).every((item) => new RegExp(String.raw`^${NAME}(?:\s+(?:asc|desc))?(?:\s+nulls\s+(?:first|last))?$`, "i").test(item));
    if (def && list && plain && !/\bwhere\b/i.test(blank(list[1]))) indexesOf(m).set(name(x[1] as string), { def, columns: names(list[0]) });
    return;
  }
  x = new RegExp(String.raw`^alter\s+index\s+(?:if\s+exists\s+)?(?:(${NAME})\.)?(${NAME})\s+rename\s+to\s+(${NAME})$`, "i").exec(text);
  if (x) {
    const [from, to] = [name(x[2] as string), name(x[3] as string)];
    // Renaming the index of a key renames its constraint.
    for (const def of m.tables.values()) if (keyNames.get(def) === from) keyNames.set(def, to);
    const index = indexesOf(m).get(from);
    indexesOf(m).delete(from);
    if (index) indexesOf(m).set(to, index);
    return;
  }
  x = new RegExp(String.raw`^create\s+(?:((?:global\s+|local\s+)?temp(?:orary)?)\s+|unlogged\s+)?table\s+(if\s+not\s+exists\s+)?${TABLE}\s*(.*)$`, "is").exec(text);
  if (x) {
    const table = publicTable(x[3], x[4]);
    // A temporary table lives in a schema of its own, for one session.
    if (x[1] || !table || (x[2] && m.tables.has(table))) return;
    m.tables.set(table, tableDef(x[5] ?? "", at, table));
    return;
  }
  x = new RegExp(String.raw`^comment\s+on\s+column\s+(?:(${NAME})\.)?(${NAME})\.(${NAME})\s+is\s+(.*)$`, "is").exec(text);
  if (x) {
    const table = publicTable(x[1], x[2]);
    const column = table ? m.tables.get(table)?.columns.find((c) => c.name === name(x?.[3] as string)) : undefined;
    const comment = literal(x[4] ?? "");
    if (!column || comment === undefined) return;
    // Postgres keeps an empty comment as none.
    if (comment) column.comment = comment;
    else delete column.comment;
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
  x = /^drop\s+table\s+(?:if\s+exists\s+)?(.*)$/is.exec(text);
  if (x) {
    for (const target of topLevelSplit(x[1] ?? "")) {
      const t = new RegExp(`^${TABLE}`).exec(target);
      const table = t && publicTable(t[1], t[2]);
      if (table) forget(m, table);
    }
  }
}

/**
 * The name of each table's primary key constraint, as given or as Postgres names it
 * (<table>_pkey, after the table's name when the key was made), so DROP CONSTRAINT can end it.
 */
const keyNames = new WeakMap<TableDef, string>();

/** Postgres's name for a table's key: <table>_pkey, the table's name cut to fit in 63 bytes. */
function keyName(table: string): string {
  const chars = [...table];
  while (new TextEncoder().encode(`${chars.join("")}_pkey`).length > 63) chars.pop();
  return `${chars.join("")}_pkey`;
}

/** A unique index on plain columns of a table, which ADD PRIMARY KEY USING INDEX can make its key. */
interface UniqueIndex {
  def: TableDef;
  columns: string[];
}

/** Each Migrations' unique indexes by name, as `supabase db diff` writes a key: CREATE UNIQUE INDEX, then ADD CONSTRAINT ... USING INDEX. */
const uniqueIndexes = new WeakMap<Migrations, Map<string, UniqueIndex>>();

function indexesOf(m: Migrations): Map<string, UniqueIndex> {
  const found = uniqueIndexes.get(m);
  if (found) return found;
  const made = new Map<string, UniqueIndex>();
  uniqueIndexes.set(m, made);
  return made;
}

/** A table renamed: its RLS, policies and definition go with it. */
function move(m: Migrations, from: string, to: string): void {
  const rls = m.rls.get(from);
  m.rls.delete(from);
  if (rls) m.rls.set(to, rls);
  const policies = m.policies.get(from);
  m.policies.delete(from);
  if (policies) m.policies.set(to, policies);
  const def = m.tables.get(from);
  m.tables.delete(from);
  if (def) m.tables.set(to, def);
}

/** A table dropped or moved out of public: nothing of it is left. */
function forget(m: Migrations, table: string): void {
  m.rls.delete(table);
  m.policies.delete(table);
  m.tables.delete(table);
}

/** Starts a table constraint or LIKE, not a column. All are reserved words but EXCLUDE, which can name a column, so USING or a parenthesis must follow it. */
const TABLE_ITEM = /^(?:(?:constraint|primary|foreign|unique|check|like|not)\b|exclude\s*(?:using\b|\())/i;

/** Ends a column's type: its first constraint, or the COLLATE or USING of ALTER ... TYPE. */
const TYPE_END = /\b(?:not|null|default|references|primary|unique|check|constraint|generated|collate|identity|using)\b/i;

/**
 * A table as CREATE TABLE defines it, from what follows its name. OF type, PARTITION OF
 * and AS take their columns from elsewhere, so they leave it incomplete and empty; so does
 * `(a, b) AS query`, which names columns without types.
 */
function tableDef(rest: string, at: Located, table: string): TableDef {
  const def: TableDef = { ...at, columns: [], primaryKey: [], userColumns: [], complete: false };
  const body = rest.startsWith("(") ? parenthesised(rest) : null;
  if (!body || /\bas\b/i.test(blank(body[1]))) return def;
  def.complete = !/\binherits\b/i.test(blank(body[1]));
  for (const item of topLevelSplit(body[0])) {
    if (TABLE_ITEM.test(item)) tableConstraint(def, item, table);
    else addColumn(def, item, table);
  }
  return def;
}

/**
 * A table constraint or LIKE: a primary key replaces the table's, a foreign key to auth.users
 * marks its columns. A key made from a unique index takes the index's columns, and the index
 * takes the constraint's name.
 */
function tableConstraint(def: TableDef, item: string, table: string, indexes?: Map<string, UniqueIndex>): void {
  const named = new RegExp(String.raw`^constraint\s+(${NAME})\s*`, "i").exec(item);
  const c = named ? item.slice(named[0].length) : item;
  if (/^like\b/i.test(c)) def.complete = false;
  const using = new RegExp(String.raw`^primary\s+key\s+using\s+index\s+(${NAME})`, "i").exec(c);
  if (using) {
    const index = name(using[1] as string);
    const found = indexes?.get(index);
    // An index this reader did not see leaves the table without a key it knows: never one it guessed.
    if (found?.def !== def) return;
    def.primaryKey = [...found.columns];
    keyNames.set(def, named ? name(named[1] as string) : index);
    return;
  }
  const key = /^(primary|foreign)\s+key\s*(\(.*)$/is.exec(c);
  const columns = key && parenthesised(key[2] as string);
  if (!columns) return;
  if (key[1]?.toLowerCase() === "primary") {
    def.primaryKey = names(columns[0]);
    keyNames.set(def, named ? name(named[1] as string) : keyName(table));
  }
  else if (referencesUsers(columns[1])) for (const column of names(columns[0])) addOnce(def.userColumns, column);
}

/** A column definition, `<name> <type> [constraints]`, appended unless the table has that column. */
function addColumn(def: TableDef, text: string, table: string): void {
  const x = new RegExp(String.raw`^(${NAME})\s*(.*)$`, "s").exec(text);
  if (!x) return;
  const column = name(x[1] as string);
  if (def.columns.some((c) => c.name === column)) return;
  const rest = x[2] ?? "";
  const end = typeEnd(rest);
  def.columns.push({ name: column, type: typeName(rest.slice(0, end)) });
  const constraints = rest.slice(end);
  const key = blank(constraints).search(/\bprimary\s+key\b/i);
  if (key !== -1) {
    addOnce(def.primaryKey, column);
    // CONSTRAINT <name> PRIMARY KEY names it; blank keeps offsets, so the name is read from the text.
    const named = new RegExp(String.raw`\bconstraint\s+(${NAME})\s*$`, "i").exec(constraints.slice(0, key));
    keyNames.set(def, named ? name(named[1] as string) : keyName(table));
  }
  if (referencesUsers(constraints)) addOnce(def.userColumns, column);
}

/** One ALTER TABLE action on a known table's columns: ADD, DROP, RENAME, or ALTER ... TYPE. */
function alterColumns(def: TableDef, action: string, table: string, indexes: Map<string, UniqueIndex>): void {
  const add = /^add\s+(.*)$/is.exec(action)?.[1];
  if (add !== undefined) {
    if (TABLE_ITEM.test(add)) tableConstraint(def, add, table, indexes);
    else addColumn(def, add.replace(/^column\s+/i, "").replace(/^if\s+not\s+exists\s+/i, ""), table);
    return;
  }
  // Dropping the primary key's constraint leaves the table with no key.
  const dropKey = new RegExp(String.raw`^drop\s+constraint\s+(?:if\s+exists\s+)?(${NAME})(?:\s+(?:cascade|restrict))?$`, "i").exec(action);
  if (dropKey) {
    if (name(dropKey[1] as string) === keyNames.get(def)) def.primaryKey = [];
    return;
  }
  const renameKey = new RegExp(String.raw`^rename\s+constraint\s+(${NAME})\s+to\s+(${NAME})$`, "i").exec(action);
  if (renameKey) {
    if (name(renameKey[1] as string) === keyNames.get(def)) keyNames.set(def, name(renameKey[2] as string));
    return;
  }
  const drop = new RegExp(String.raw`^drop\s+(?!constraint\s)(?:column\s+)?(?:if\s+exists\s+)?(${NAME})(?:\s+(?:cascade|restrict))?$`, "i").exec(action);
  if (drop) {
    const column = name(drop[1] as string);
    def.columns = def.columns.filter((c) => c.name !== column);
    // Postgres drops a constraint with any of its columns, so a composite key goes whole.
    if (def.primaryKey.includes(column)) def.primaryKey = [];
    def.userColumns = def.userColumns.filter((c) => c !== column);
    return;
  }
  // RENAME TO renames the table and RENAME CONSTRAINT a constraint: neither matches here.
  const rename = new RegExp(String.raw`^rename\s+(?:column\s+)?(${NAME})\s+to\s+(${NAME})$`, "i").exec(action);
  if (rename) {
    const [from, to] = [name(rename[1] as string), name(rename[2] as string)];
    const column = def.columns.find((c) => c.name === from);
    if (!column) return;
    column.name = to;
    def.primaryKey = def.primaryKey.map((c) => (c === from ? to : c));
    def.userColumns = def.userColumns.map((c) => (c === from ? to : c));
    return;
  }
  const retype = new RegExp(String.raw`^alter\s+(?:column\s+)?(${NAME})\s+(?:set\s+data\s+)?type\s+(.*)$`, "is").exec(action);
  const column = retype && def.columns.find((c) => c.name === name(retype[1] as string));
  const type = retype?.[2] ?? "";
  if (column) column.type = typeName(type.slice(0, typeEnd(type)));
}

/** Whether `text` has a REFERENCES to auth.users outside parentheses and strings. */
function referencesUsers(text: string): boolean {
  for (const r of blank(text).matchAll(/\breferences\b/gi)) {
    const t = new RegExp(String.raw`^references\s*${TABLE}`, "i").exec(text.slice(r.index));
    if (t?.[1] && name(t[1]) === "auth" && name(t[2] as string) === "users") return true;
  }
  return false;
}

/** Where a column's type ends in what follows the column's name. */
function typeEnd(text: string): number {
  const at = blank(text).search(TYPE_END);
  return at === -1 ? text.length : at;
}

/** A type as written, lowercased outside quoted names. */
const typeName = (raw: string) => raw.trim().replace(/"(?:[^"]|"")*"|[^"]+/g, (s) => (s.startsWith('"') ? s : s.toLowerCase()));

/** The names in a column list, as Postgres resolves them. */
function names(list: string): string[] {
  return topLevelSplit(list).flatMap((item) => {
    const n = new RegExp(`^${NAME}`).exec(item)?.[0];
    return n ? [name(n)] : [];
  });
}

function addOnce(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

/** A string constant's text ('' unescaped, or dollar-quoted), null for NULL, undefined for anything else. */
function literal(text: string): string | null | undefined {
  if (/^null$/i.test(text)) return null;
  const quoted = /^'((?:[^']|'')*)'$/s.exec(text);
  if (quoted) return (quoted[1] ?? "").replaceAll("''", "'");
  // E'...': backslash escapes too (\' and \\); other escapes are left as written.
  const escaped = /^E'((?:[^'\\]|\\.|'')*)'$/is.exec(text);
  if (escaped) return (escaped[1] ?? "").replace(/''|\\(['\\])/g, (_, c: string | undefined) => c ?? "'");
  return /^\$([A-Za-z0-9_]*)\$(.*)\$\1\$$/s.exec(text)?.[2];
}

/** A policy statement up to its USING or WITH CHECK, where AS, FOR and TO are read. */
const beforeClauses = (rest: string) => rest.split(/\busing\s*\(|\bwith\s+check\s*\(/i)[0] ?? "";

/** The roles after TO, lowercased; undefined when there is no TO. */
function roles(head: string): string[] | undefined {
  const to = /\bto\s+(.+)$/is.exec(head)?.[1];
  return to ? to.split(",").map((r) => name(r.trim())) : undefined;
}

/**
 * Where the string or quoted name that opens at `i` ends: the index after its closing quote,
 * or the text's length. A doubled quote continues it, and in an E'...' string so does \'.
 */
function quotedEnd(text: string, i: number): number {
  const quote = text[i];
  const escapes = quote === "'" && /^[Ee]$/.test(text[i - 1] ?? "") && !/^[A-Za-z0-9_$]$/.test(text[i - 2] ?? "");
  for (let j = i + 1; j < text.length; j++) {
    if (escapes && text[j] === "\\") j++;
    else if (text[j] === quote) {
      if (text[j + 1] !== quote) return j + 1;
      j++;
    }
  }
  return text.length;
}

/** Parts of `text` split on commas outside parentheses and strings. */
function topLevelSplit(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') i = quotedEnd(text, i) - 1;
    else if (ch === "(") depth++;
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
  return m ? (parenthesised(text.slice(m.index + m[0].length - 1))?.[0] ?? null) : null;
}

/** What is inside the parentheses `text` opens with, and what follows them; null when they never close. */
function parenthesised(text: string): [inside: string, after: string] | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') i = quotedEnd(text, i) - 1;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return [text.slice(1, i).trim(), text.slice(i + 1).trim()];
  }
  return null;
}

/** `text` with strings, quoted names and what parentheses hold blanked: a word found in it is top-level, at the same offset. */
function blank(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"') {
      const stop = quotedEnd(text, i);
      out += " ".repeat(stop - i);
      i = stop - 1;
    } else {
      if (ch === ")") depth--;
      out += depth > 0 ? " " : ch;
      if (ch === "(") depth++;
    }
  }
  return out;
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
    const dollar = ch === "$" ? /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0] : undefined;
    if (ch === "'" || ch === '"' || dollar) {
      const end = dollar ? sql.indexOf(dollar, i + dollar.length) : -1;
      const stop = !dollar ? quotedEnd(sql, i) : end === -1 ? sql.length : end + dollar.length;
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
