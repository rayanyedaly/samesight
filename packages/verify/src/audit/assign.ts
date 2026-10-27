/**
 * Which app_metadata and user_metadata values each run user holds. Every path the rules
 * compare with literals gets a pool: those literals, as the rules type them, plus one value
 * none of them match. Users take every combination of the pools when there are at most six,
 * else as many as six users can show, holding every value when each pool fits; then one user
 * holds the same claims as the first (rows of someone else with the same role), and one holds
 * none. Pure: the run signs the users up with what this gives them.
 */

import type { ClaimValue } from "samesight/compiler";
import type { Finding } from "../report.ts";
import type { ClaimsPlan } from "./claims.ts";

/** Users before the copy and the user with no claims. */
const SPREAD = 6;
const MIN_USERS = 4;

export interface SetPath {
  path: string[];
  key: string;
  /** The values users take: the rules' literals, then the one none of them match, if any. */
  pool: ClaimValue[];
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
    return numbers.length ? Math.floor(Math.max(...numbers)) + 1 : 1;
  }
  if (family === "boolean") return [true, false].find((b) => !values.includes(b));
  return "samesight-other";
}

function castFamily(cast: string): "uuid" | "number" | "boolean" | "text" | "unknown" {
  if (cast === "uuid") return "uuid";
  if (/^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|double precision|float4|float8)(\(.*\))?$/.test(cast)) return "number";
  if (/^(boolean|bool)$/.test(cast)) return "boolean";
  if (/^(text|varchar|character varying|json|jsonb)(\(.*\))?$/.test(cast)) return "text";
  return "unknown";
}

const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((k, i) => b[i] === k);

export function assignClaims(plan: ClaimsPlan, fresh: () => string): Assignment {
  const notSet = new Map<string, string>();
  const candidates = plan.uses.filter((u) => u.cls === "app_metadata" || u.cls === "user_metadata");
  const paths: SetPath[] = [];
  for (const u of candidates) {
    const prefixOf = candidates.find((o) => o !== u && (isPrefix(o.path, u.path) || isPrefix(u.path, o.path)));
    if (u.other.length) notSet.set(u.key, `a rule uses it as ${u.other.join("; ")}, so audit cannot tell what value it needs`);
    else if (prefixOf) notSet.set(u.key, `rules also read ${prefixOf.key}, so audit cannot give users a value at both`);
    else if (u.values.every((v) => v === null) && u.columns.length > 0) {
      notSet.set(u.key, `it is compared only with ${u.columns.length === 1 ? "column" : "columns"} ${u.columns.join(", ")}; users are not given values for that yet`);
    } else {
      // A user with no claims shows null (IS NULL): the pool holds values.
      const values = u.values.filter((v) => v !== null);
      const other = otherValue(values, u.casts, fresh);
      const pool = other === undefined ? values : [...values, other];
      if (pool.length) paths.push({ path: u.path, key: u.key, pool });
      else notSet.set(u.key, "audit found no value of the type its casts need");
    }
  }

  const sizes = paths.map((p) => p.pool.length);
  const combos = sizes.reduce((a, b) => a * b, 1);
  const count = paths.length === 0 ? MIN_USERS : Math.min(Math.max(combos + 2, MIN_USERS), SPREAD + 2);
  const spread = count - 2;
  const picked = pickCombinations(sizes, spread);
  const users: Map<string, ClaimValue>[] = [];
  if (paths.length > 0) {
    for (let i = 0; i < spread; i++) users.push(new Map((picked[i % picked.length] ?? []).map((d, p) => [paths[p]?.key as string, paths[p]?.pool[d] as ClaimValue])));
    users.push(new Map(users[0]));
  }
  while (users.length < count) users.push(new Map());

  const findings: Finding[] = [];
  const unheld = paths.flatMap((p) => p.pool.filter((v) => !users.some((u) => u.has(p.key) && JSON.stringify(u.get(p.key)) === JSON.stringify(v))).map((v) => `${p.key}=${show(v)}`));
  if (unheld.length) findings.push({ status: "warn", check: "claims", detail: `${count} users cannot hold every value: no user holds ${unheld.join(", ")}` });
  if (paths.length > 1 && combos > spread) {
    const held = new Set(users.filter((u) => u.size).map((u) => JSON.stringify([...u])));
    findings.push({ status: "warn", check: "claims", detail: `${combos} combinations of claim values, and ${count} users hold ${held.size} of them; rules that need values together may not be tested` });
  }
  return { paths, users, notSet, findings };
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
export function metadataOf(paths: SetPath[], values: Map<string, ClaimValue>): Metadata {
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
