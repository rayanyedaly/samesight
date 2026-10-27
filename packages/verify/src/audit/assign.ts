/**
 * Which app_metadata and user_metadata values each run user holds. Every path the rules
 * compare with literals gets a pool: those literals, as the rules type them, plus one value
 * none of them match. Users take every combination of the pools when there are at most six,
 * else as many as six users can show, holding every value when each pool fits; then one user
 * holds the same claims as the first (rows of someone else with the same role), and one holds
 * none. A path compared only with columns gets two values of the claim's cast or the first
 * column's type (fresh run uuids, two numbers, true and false, two short strings, or a
 * CHECK or enum list's first two), and generated rows take a path's values in the columns
 * it is compared with, where their type, length and list take them: a uuid key column's
 * first rows take the run's own uuids among them as keys (a foreign key's referenced table,
 * for a foreign key), any other column draws them often. Columns are matched by bare name
 * in the tables of the rules that compare them. Pure: the run signs
 * the users up, and generates rows, with what this gives.
 */

import { type ClaimValue, canonicalNumber } from "samesight/compiler";

export { canonicalNumber };
import { jsPattern, type TableModel } from "../differential/model.ts";
import type { Finding } from "../report.ts";
import type { ClaimsPlan } from "./claims.ts";
import { type Dim, dimLabel } from "./fixed.ts";

/** Users before the copy and the user with no claims. */
const SPREAD = 6;
const MIN_USERS = 4;
/** The most users a run signs up. */
export const MAX_USERS = SPREAD + 2;

export interface SetPath {
  path: string[];
  key: string;
  /** The values users take: the rules' literals, then the one none of them match, if any. */
  pool: ClaimValue[];
  /** Columns generated rows put these values in, as table.column. */
  columns: string[];
  /** Columns compared with it that get none, and why. */
  skipped: string[];
  /** Primary keys of that name no rule names the table of, so none is keyed (said once per name). */
  unkeyed: string[];
  /** The pool is the ids of the first run users, by index (u0, u1). */
  users?: true;
  /** Every rule reads the claim as a number: 1, 1.0 and '01' are one value. */
  numeric?: true;
}

export type Metadata = Partial<Record<"app_metadata" | "user_metadata", Record<string, unknown>>>;

export interface Assignment {
  paths: SetPath[];
  /** Per run user, by index: the value of each set path, by key. Absent: the user holds none. */
  users: Map<string, ClaimValue>[];
  /** Why each path the rules read in metadata is not set, by key. */
  notSet: Map<string, string>;
  /** Values and combinations no user holds, when they do not fit. */
  findings: Finding[];
  /** Some combination of values of two or more paths is held by no user. */
  partial: boolean;
  /** Per table and column, values generated rows draw often. */
  claimValues: Map<string, Map<string, unknown[]>>;
  /** Per table, a key column whose first generated rows take these values. */
  keyPools: Map<string, { column: string; values: unknown[] }>;
  /** Per run user, by index: the option each access token hook dim takes (see fixed.ts); absent: no hook rows. */
  hookPicks: (number[] | undefined)[];
}

/** Values of a column's type that two users can tell apart. */
const COLUMN_POOL = 2;

interface Target {
  table: string;
  column: string;
  /** Rows take the values as keys (the first rows), or draw them. */
  key: boolean;
  /** The column's own CHECK or enum values. */
  values?: string[];
  /** Its CHECK pattern (col ~ '...'). */
  pattern?: string;
  /** A key to auth.users: rows take run users, so the claim's values are run user ids. */
  users?: boolean;
  type: string;
}

/** Where generated rows put a path's values, and the columns compared with it that cannot take them. */
function targetsOf(columns: string[], columnTables: Record<string, string[]>, family: string | undefined, model: TableModel[]): { targets: Target[]; skipped: string[]; unkeyed: string[] } {
  const targets: Target[] = [];
  const skipped: string[] = [];
  const unkeyed: string[] = [];
  for (const name of columns) {
    // Rules whose table is unknown (a subquery, a CTE) leave every table with the name: then
    // a primary key is never keyed, since \`id\` would match every table's.
    const known = Boolean(columnTables[name]?.length);
    const tables = known ? model.filter((t) => columnTables[name]?.includes(t.name)) : model;
    if (!tables.some((t) => t.columns.some((c) => c.name === name))) skipped.push(`${name} (no generated table has it)`);
    const keysOf: string[] = [];
    for (const t of tables) {
      const col = t.columns.find((c) => c.name === name);
      if (!col) continue;
      const kind = castFamily(col.type);
      if (family !== undefined && kind !== family) {
        skipped.push(`${t.name}.${name} (${col.type}, which the rules do not cast the claim to)`);
        continue;
      }
      if (kind === "unknown" && !col.values?.length) {
        skipped.push(`${t.name}.${name} (${col.type}, which audit generates no claim values for)`);
        continue;
      }
      if (t.foreignKeys.some((k) => k.columns.length > 1 && k.columns.includes(name))) {
        skipped.push(`${t.name}.${name} (part of a composite foreign key, which generated rows fill from parent rows)`);
        continue;
      }
      const fk = t.foreignKeys.find((k) => k.columns.length === 1 && k.columns[0] === name);
      if (fk?.schema === "auth" && fk.table === "users") {
        // Generated rows already point such a column at run users: the claim holds their ids.
        targets.push({ table: t.name, column: name, key: false, users: true, type: col.type });
      } else if (fk) {
        const parent = model.find((m) => m.name === fk.table);
        const ref = fk.references[0] as string;
        if (parent && parent.primaryKey.length === 1 && parent.primaryKey[0] === ref) targets.push({ table: parent.name, column: ref, key: true, type: col.type });
        else skipped.push(`${t.name}.${name} (a key to ${fk.table}.${ref}, which the run does not generate keys for)`);
      } else if (t.primaryKey.length === 1 && t.primaryKey[0] === name) {
        if (known) targets.push({ table: t.name, column: name, key: true, type: col.type });
        else keysOf.push(t.name);
      } else {
        if (col.pattern !== undefined && !jsPattern(col.pattern)) {
          skipped.push(`${t.name}.${name} (a CHECK pattern audit cannot read)`);
          continue;
        }
        targets.push({
          table: t.name,
          column: name,
          key: false,
          type: col.type,
          ...(col.values?.length ? { values: col.values } : {}),
          ...(col.pattern !== undefined ? { pattern: col.pattern } : {}),
        });
      }
    }
    // One note for the name, not one per table: id is the primary key of most of them.
    if (keysOf.length) unkeyed.push(`${name} (the primary key of ${keysOf.join(", ")}; no rule comparing it names its table, so none is keyed)`);
  }
  const seen = new Set<string>();
  return { targets: targets.filter((x) => !seen.has(`${x.table}.${x.column}`) && seen.add(`${x.table}.${x.column}`)), skipped, unkeyed };
}

/** Integer types and the values they hold. */
const WHOLE: Record<string, [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  int2: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  int: [-2147483648n, 2147483647n],
  int4: [-2147483648n, 2147483647n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
  int8: [-9223372036854775808n, 9223372036854775807n],
};

/** How values of a claim are told apart: by canonical number when the rules read it as one, else exactly. */
export const valueKeyFor =
  (numeric: boolean | undefined) =>
  (v: unknown): string => {
    const n = numeric ? canonicalNumber(v) : undefined;
    return n === undefined ? JSON.stringify(v ?? null) : `#${n}`;
  };

/**
 * Whether the value is a number the type stores exactly: whole and in range, or within
 * numeric(p,s). `numeric` says the rules read the claim as a number; read as text, a whole
 * or float column matches only the spelling Postgres prints back (100, not 1e2 or 0100).
 */
function fitsNumber(v: ClaimValue, type: string, numeric = false): boolean {
  const text = typeof v === "number" ? (Number.isFinite(v) ? String(v) : undefined) : typeof v === "string" ? v : undefined;
  if (text !== undefined && /^(real|float4|double precision|float8)$/.test(type) && canonicalNumber(text) !== undefined) {
    const n = Number(text);
    const stored = /^(real|float4)$/.test(type) ? Math.fround(n) : n;
    // Read as a number, any spelling of a number the float holds exactly (1e2, 0.50). Read as
    // text, the one Postgres prints, which JS shares only where neither takes an exponent.
    const point = Number(/e(-?\d+)$/.exec(canonicalNumber(text) ?? "")?.[1] ?? 1);
    const plain = n === 0 || (point >= -3 && point <= (/^(real|float4)$/.test(type) ? 6 : 15));
    const exact = numeric ? canonicalNumber(String(stored)) === canonicalNumber(text) : plain && String(stored) === text;
    return Number.isFinite(n) && exact;
  }
  if (text === undefined || !/^-?\d+(\.\d+)?$/.test(text)) return false;
  // Read as text, a number column matches only its printed form: no leading zero or minus zero.
  if (!numeric && (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) || /^-0(\.0+)?$/.test(text))) return false;
  const range = WHOLE[type];
  if (range) {
    if (!/^-?\d+$/.test(text) || (typeof v === "number" && !Number.isSafeInteger(v))) return false;
    if (!numeric && String(BigInt(text)) !== text) return false;
    const n = BigInt(text);
    return n >= range[0] && n <= range[1];
  }
  // A negative scale rounds to tens or hundreds: no claim value is kept exactly there.
  if (/^(?:numeric|decimal)\(\d+,\s*-\d+\)$/.test(type)) return false;
  const ps = /^(?:numeric|decimal)\((\d+)(?:,\s*(\d+))?\)$/.exec(type);
  if (ps) {
    const [whole = "", fraction = ""] = text.replace(/^-/, "").split(".");
    const scale = Number(ps[2] ?? 0);
    // Postgres prints numeric(p,s) with s decimals: 1.5 as 1.50.
    if (!numeric && fraction.length !== scale) return false;
    return fraction.replace(/0+$/, "").length <= scale && whole.replace(/^0+/, "").length <= Number(ps[1]) - scale;
  }
  return true;
}

/** Whether a column of this type takes the value: generated rows never hold one the database refuses. */
export function fitsType(v: ClaimValue, type: string, numeric = false): boolean {
  switch (castFamily(type)) {
    case "uuid":
      return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    case "number":
      return fitsNumber(v, type, numeric);
    case "boolean":
      return typeof v === "boolean";
    case "text": {
      // A json column takes only JSON text, which no pool value is meant to be.
      if (typeof v === "object" || /^jsonb?$/.test(type)) return false;
      const n = /\((\d+)\)$/.exec(type);
      return !n || String(v).length <= Number(n[1]);
    }
    default:
      // An enum or another type: only its own listed values, checked by the caller.
      return typeof v === "string";
  }
}

/** Two values of the targets' type for a path compared only with columns; undefined when audit has none. */
function columnPool(targets: Target[], family: string | undefined, fresh: () => string): ClaimValue[] | undefined {
  const listed = targets.find((x) => x.values?.length)?.values;
  if (listed && !targets.some((x) => x.key)) return listed.slice(0, COLUMN_POOL);
  switch (family ?? castFamily(targets[0]?.type ?? "")) {
    case "uuid":
      return Array.from({ length: COLUMN_POOL }, fresh);
    case "number":
      return [101, 102];
    case "boolean":
      return [true, false];
    case "text":
      return ["ss-a", "ss-b"];
    default:
      return undefined;
  }
}

/** The value none of the literals match, of the type every cast on the path accepts; undefined when there is none. */
export function otherValue(values: ClaimValue[], casts: string[], fresh: () => string): ClaimValue | undefined {
  const families = new Set(casts.map(castFamily));
  // A date, a timestamp, an array, or casts that disagree: no value every cast surely takes.
  if (families.has("unknown") || families.size > 1) return undefined;
  const family = [...families][0] ?? (values.some((v) => typeof v === "number") ? "number" : values.length > 0 && values.every((v) => typeof v === "boolean") ? "boolean" : "text");
  if (family === "uuid") return fresh();
  if (family === "number") {
    const numbers = values.filter((v): v is number => typeof v === "number");
    // The first candidate no literal matches that every cast stores exactly (a smallint's max + 1 does not).
    const candidates = numbers.length ? [Math.floor(Math.max(...numbers)) + 1, Math.ceil(Math.min(...numbers)) - 1, 0, 1] : [1, 0];
    // No spelling of a literal ('01' for 1) counts as another value.
    const taken = new Set(values.map((v) => canonicalNumber(v) ?? ""));
    return candidates.find((c) => !taken.has(canonicalNumber(c) ?? "") && casts.every((cast) => castFamily(cast) !== "number" || fitsNumber(c, cast)));
  }
  if (family === "boolean") return [true, false].find((b) => !values.includes(b));
  return "samesight-other";
}

export function castFamily(cast: string): "uuid" | "number" | "boolean" | "text" | "unknown" {
  if (cast === "uuid") return "uuid";
  if (/^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|double precision|float|float4|float8)(\(.*\))?$/.test(cast)) return "number";
  if (/^(boolean|bool)$/.test(cast)) return "boolean";
  if (/^(text|varchar|character varying|json|jsonb)(\(.*\))?$/.test(cast)) return "text";
  return "unknown";
}

const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((k, i) => b[i] === k);

export function assignClaims(plan: ClaimsPlan, mintKey: () => string, model: TableModel[] = [], userIds: string[] = [], dims: Dim[] = [], fixedTables: string[] = []): Assignment {
  // Only values minted here (the run's prefixed uuids) become keys: cleanup finds the run's
  // rows by that prefix, so a row keyed by a rule's own literal would outlive the run.
  const minted = new Set<string>();
  const fresh = () => {
    const v = mintKey();
    minted.add(v);
    return v;
  };
  const notSet = new Map<string, string>();
  const claimValues = new Map<string, Map<string, unknown[]>>();
  const keyPools = new Map<string, { column: string; values: unknown[] }>();
  const candidates = plan.uses.filter((u) => u.cls === "app_metadata" || u.cls === "user_metadata");
  const paths: SetPath[] = [];
  for (const u of candidates) {
    const prefixOf = candidates.find((o) => o !== u && (isPrefix(o.path, u.path) || isPrefix(u.path, o.path)));
    if (u.other.length) notSet.set(u.key, `a rule uses it as ${u.other.join("; ")}, so audit cannot tell what value it needs`);
    else if (prefixOf) notSet.set(u.key, `rules also read ${prefixOf.key}, so audit cannot give users a value at both`);
    else {
      const families = new Set(u.casts.map(castFamily));
      const family = families.size === 1 && !families.has("unknown") ? [...families][0] : undefined;
      const found = targetsOf(u.columns, u.columnTables, family, model);
      const skipped = found.skipped;
      const usable = found.targets.filter((x) => {
        if (x.key && castFamily(x.type) !== "uuid") {
          // A key takes only fresh run uuids (cleanup finds its rows by them): a text or number key takes none.
          skipped.push(`${x.table}.${x.column} (a ${x.type} key: keys take only fresh run uuids)`);
          return false;
        }
        return true;
      });
      // Without a cast, the pool follows the first usable column's type; columns of another type get none.
      const first = usable.find((x) => !x.users) ?? usable[0];
      const lead = family ?? (first ? castFamily(first.type) : undefined);
      const targets = usable.filter((x) => {
        if (family !== undefined || x.users || castFamily(x.type) === lead || x.values?.length) return true;
        skipped.push(`${x.table}.${x.column} (${x.type}, unlike ${first?.table}.${first?.column})`);
        return false;
      });
      // A user with no claims shows null (IS NULL): the pool holds values.
      const values = u.values.filter((v) => v !== null);
      let pool: ClaimValue[] | undefined;
      if (values.length === 0 && u.columns.length > 0) {
        // Compared only with user columns: the ids of two run users (u0 and u1), which rows point at.
        // Beside other columns, those take fresh values, which no user column can hold.
        const userPool = targets.length > 0 && targets.every((x) => x.users) && userIds.length >= COLUMN_POOL ? userIds.slice(0, COLUMN_POOL) : undefined;
        if (!userPool) for (const x of targets.filter((y) => y.users)) skipped.push(`${x.table}.${x.column} (a key to auth.users, which takes only run users' ids)`);
        pool = userPool ?? (targets.length && families.size <= 1 && !families.has("unknown") ? columnPool(targets.filter((x) => !x.users), lead, fresh) : undefined);
        if (!pool) {
          const notes = [...skipped, ...found.unkeyed];
          const why = notes.length ? `: ${notes.join("; ")}` : targets.length ? ", and audit has no values of their type" : "";
          notSet.set(u.key, `it is compared only with ${u.columns.length === 1 ? "column" : "columns"} ${u.columns.join(", ")}, and no generated row can hold its values${why}`);
          continue;
        }
      } else {
        const other = otherValue(values, u.casts, fresh);
        pool = other === undefined ? values : [...values, other];
      }
      if (!pool.length) {
        notSet.set(u.key, "audit found no value of the type its casts need");
        continue;
      }
      const placed: string[] = [];
      for (const x of targets) {
        if (x.users) {
          // Rows already point user columns at run users; the claim holds two of their ids.
          if (pool.some((v) => typeof v === "string" && userIds.includes(v))) placed.push(`${x.table}.${x.column}`);
          else if (!skipped.some((n) => n.startsWith(`${x.table}.${x.column} (`))) skipped.push(`${x.table}.${x.column} (a key to auth.users, which takes only run users' ids)`);
          continue;
        }
        // Only values the column takes: its type, its length, its CHECK or enum list.
        const fits = pool.filter((v) => fitsType(v, x.type, u.numeric) && (!x.values || x.values.includes(String(v))) && (x.pattern === undefined || jsPattern(x.pattern)?.test(String(v)) === true));
        if (!fits.length) {
          skipped.push(`${x.table}.${x.column} (${x.values ? "its CHECK or enum list allows" : x.pattern !== undefined ? "its CHECK pattern takes" : `${x.type} takes`} none of the values)`);
          continue;
        }
        if (x.key) {
          const keys = fits.filter((v) => typeof v === "string" && minted.has(v));
          const left = fits.filter((v) => !keys.includes(v));
          // A key takes only fresh run uuids, so cleanup finds its rows: a rule's own literal is held by a user, by no row.
          if (left.length) skipped.push(`${x.table}.${x.column} for ${left.map(show).join(", ")} (a key takes only fresh run uuids, so cleanup finds its rows)`);
          if (!keys.length) continue;
          // One pool of keys per table: a second claim keyed on the same table is not placed.
          const taken = keyPools.get(x.table);
          if (taken && taken.column !== x.column) {
            skipped.push(`${x.table}.${x.column} (the table's first rows already take another claim's keys)`);
            continue;
          }
          keyPools.set(x.table, { column: x.column, values: [...new Set([...(taken?.values ?? []), ...keys])] });
        } else {
          const columns = claimValues.get(x.table) ?? new Map<string, unknown[]>();
          claimValues.set(x.table, columns);
          columns.set(x.column, [...new Set([...(columns.get(x.column) ?? []), ...fits])]);
        }
        placed.push(`${x.table}.${x.column}`);
      }
      // Values only for columns, and no column took them: no user should hold values no row can.
      if (values.length === 0 && u.columns.length > 0 && placed.length === 0) {
        notSet.set(u.key, `it is compared only with ${u.columns.length === 1 ? "column" : "columns"} ${u.columns.join(", ")}, and no generated row can hold its values: ${[...skipped, ...found.unkeyed].join("; ")}`);
        continue;
      }
      paths.push({
        path: u.path,
        key: u.key,
        pool,
        columns: placed,
        skipped,
        unkeyed: found.unkeyed,
        ...(pool.length && pool.every((v) => typeof v === "string" && userIds.includes(v)) ? { users: true as const } : {}),
        ...(u.numeric ? { numeric: true as const } : {}),
      });
    }
  }

  // Claims the access token hook adds, compared with a column: generated rows draw the values
  // the hook can give (a CHECK list's lead and member, the rules' literals), as for metadata.
  // Keys, user columns and the hook's own per-user tables are left alone.
  const hookOptions = dims.flatMap((d) => (d.column !== null && !d.parent ? d.options : [])) as ClaimValue[];
  const perUser = new Set(dims.map((d) => d.table));
  // The fixed tables per-user rows reach (teams, and their orgs): their few rows take the values in turn.
  const parents = new Set([...dims.flatMap((d) => (d.parent ? [d.parent] : [])), ...fixedTables.filter((t) => !perUser.has(t))]);
  for (const u of plan.uses.filter((x) => x.cls === "hook" && x.columns.length > 0 && x.other.length === 0)) {
    const families = new Set(u.casts.map(castFamily));
    const family = families.size === 1 && !families.has("unknown") ? [...families][0] : undefined;
    const same = valueKeyFor(u.numeric);
    const given = [...u.values.filter((v) => v !== null), ...hookOptions];
    // A value no rule names beside them, as for metadata: one value alone would make every row alike.
    const other = otherValue(given, u.casts, mintKey);
    const values = [...given, ...(other === undefined ? [] : [other])].filter((v, i, all) => all.findIndex((w) => same(w) === same(v)) === i);
    for (const x of targetsOf(u.columns, u.columnTables, family, model).targets) {
      if (x.key || x.users || perUser.has(x.table)) continue;
      const fits = values.filter((v) => fitsType(v, x.type, u.numeric) && (!x.values || x.values.includes(String(v))) && (x.pattern === undefined || jsPattern(x.pattern)?.test(String(v)) === true));
      // A parent's rows take them in turn: fewer than two values would leave every team alike.
      if (fits.length < (parents.has(x.table) ? 2 : 1)) continue;
      const columns = claimValues.get(x.table) ?? new Map<string, unknown[]>();
      claimValues.set(x.table, columns);
      columns.set(x.column, [...new Set([...(columns.get(x.column) ?? []), ...fits])]);
    }
  }

  // Metadata values and the access token hook's rows are picked together: a role with a team.
  const sizes = [...paths.map((p) => p.pool.length), ...dims.map((d) => d.options.length)];
  const combos = sizes.reduce((a, b) => a * b, 1);
  const count = sizes.length === 0 ? MIN_USERS : Math.min(Math.max(combos + 2, MIN_USERS), MAX_USERS);
  const spread = count - 2;
  const picked = pickCombinations(sizes, spread);
  const users: Map<string, ClaimValue>[] = [];
  const hookPicks: (number[] | undefined)[] = [];
  if (sizes.length > 0) {
    for (let i = 0; i < spread; i++) {
      const c = picked[i % picked.length] ?? [];
      users.push(new Map(c.slice(0, paths.length).map((d, p) => [paths[p]?.key as string, paths[p]?.pool[d] as ClaimValue])));
      hookPicks.push(dims.length ? c.slice(paths.length) : undefined);
    }
    // Someone else with the same values and rows, so a role also sees others' rows.
    users.push(new Map(users[0]));
    hookPicks.push(hookPicks[0]);
  }
  while (users.length < count) {
    users.push(new Map());
    hookPicks.push(undefined);
  }

  const findings: Finding[] = [];
  const unheld = [
    ...paths.flatMap((p) => p.pool.filter((v) => !users.some((u) => u.has(p.key) && JSON.stringify(u.get(p.key)) === JSON.stringify(v))).map((v) => `${p.key}=${show(v)}`)),
    ...dims.flatMap((d, i) => d.options.filter((_, o) => !hookPicks.some((h) => h?.[i] === o)).map((o) => `${dimLabel(d, o)} (an access token hook row)`)),
  ];
  if (unheld.length) findings.push({ status: "warn", check: "claims", detail: `${count} users cannot hold every value: no user holds ${unheld.join(", ")}` });
  const partial = sizes.length > 1 && combos > spread;
  if (partial) {
    const held = new Set(users.map((u, i) => JSON.stringify([[...u], hookPicks[i] ?? null])).filter((_, i) => (users[i]?.size ?? 0) > 0 || hookPicks[i] !== undefined));
    const of = dims.length ? (paths.length ? "claim values and access token hook rows" : "access token hook rows") : "claim values";
    findings.push({ status: "warn", check: "claims", detail: `${combos} combinations of ${of}, and ${count} users hold ${held.size} of them; rules that need values together may not be tested` });
  }
  return { paths, users, notSet, findings, partial, claimValues, keyPools, hookPicks };
}

/** Beyond this many combinations, users take value i of each pool, which still holds each value while pools fit. */
const ENUMERATED = 4096;

/**
 * Up to `n` combinations of pool indices: every one, in mixed-radix order, when there are at
 * most `n`; else picked one at a time for the most values no user holds yet, then the most
 * pairs of values none holds together.
 */
export function pickCombinations(sizes: number[], n: number): number[][] {
  const total = sizes.reduce((a, b) => a * b, 1);
  const decode = (i: number) => {
    let rest = i;
    return sizes.map((k) => {
      const d = rest % k;
      rest = Math.floor(rest / k);
      return d;
    });
  };
  if (total <= n) return Array.from({ length: total }, (_, i) => decode(i));
  if (total > ENUMERATED) return Array.from({ length: n }, (_, i) => sizes.map((k) => i % k));
  const all = Array.from({ length: total }, (_, i) => decode(i));
  const values = new Set<string>();
  const pairs = new Set<string>();
  const out: number[][] = [];
  const valueKeys = (c: number[]) => c.map((d, p) => `${p}:${d}`);
  const pairKeys = (c: number[]) => c.flatMap((d, p) => c.slice(p + 1).map((e, q) => `${p}:${d}/${p + q + 1}:${e}`));
  while (out.length < n) {
    let best = all[0] as number[];
    let score = -1;
    for (const c of all) {
      if (out.includes(c)) continue;
      const s = 1000 * valueKeys(c).filter((k) => !values.has(k)).length + pairKeys(c).filter((k) => !pairs.has(k)).length;
      if (s > score) {
        best = c;
        score = s;
      }
    }
    out.push(best);
    for (const k of valueKeys(best)) values.add(k);
    for (const k of pairKeys(best)) pairs.add(k);
  }
  return out;
}

/** The create-user body's metadata for one user's values. */
export function metadataOf(paths: Pick<SetPath, "path" | "key">[], values: Map<string, ClaimValue>): Metadata {
  const out: Metadata = {};
  for (const p of paths) {
    if (!values.has(p.key)) continue;
    const [top, ...rest] = p.path as ["app_metadata" | "user_metadata", ...string[]];
    // Objects without a prototype: a key named __proto__ is then only a key.
    out[top] ??= Object.create(null) as Record<string, unknown>;
    let at = out[top];
    for (const k of rest.slice(0, -1)) {
      at[k] ??= Object.create(null) as Record<string, unknown>;
      at = at[k] as Record<string, unknown>;
    }
    at[rest.at(-1) as string] = values.get(p.key);
  }
  return out;
}

/** A value as labels show it: a string bare (editor), unless it reads as another type ("3"). */
export const show = (v: unknown) => (typeof v === "string" && !/^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? v : JSON.stringify(v ?? null));
