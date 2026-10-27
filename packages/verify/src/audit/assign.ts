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
  const cast = (re: RegExp) => casts.some((c) => re.test(c));
  if (cast(/^uuid$/)) return fresh();
  if (cast(/^(smallint|integer|int|int2|int4|int8|bigint|numeric|decimal|real|double precision|float4|float8)(\(.*\))?$/) || values.some((v) => typeof v === "number")) {
    const numbers = values.filter((v): v is number => typeof v === "number");
    return numbers.length ? Math.floor(Math.max(...numbers)) + 1 : 1;
  }
  if (cast(/^(boolean|bool)$/) || (values.length > 0 && values.every((v) => typeof v === "boolean"))) {
    return [true, false].find((b) => !values.includes(b));
  }
  // A date, a timestamp or an array: no value audit can be sure every cast takes.
  if (casts.some((c) => !/^(text|varchar|character varying|json|jsonb)(\(.*\))?$/.test(c))) return undefined;
  return "samesight-other";
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
    else if (u.values.length === 0 && u.columns.length > 0) notSet.set(u.key, `it is compared only with ${u.columns.length === 1 ? "column" : "columns"} ${u.columns.join(", ")}; users are not given values for that yet`);
    else {
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
  const digits = (i: number): number[] => {
    if (combos <= SPREAD) {
      // Mixed radix: users 0 to combos - 1 hold every combination, in order.
      let rest = i % combos;
      return sizes.map((k) => {
        const d = rest % k;
        rest = Math.floor(rest / k);
        return d;
      });
    }
    // Too many to hold all: shifted diagonals, so each value is held while pools fit.
    const widest = Math.max(...sizes);
    return sizes.map((k, p) => (i + p * Math.floor(i / widest)) % k);
  };
  const users: Map<string, ClaimValue>[] = [];
  if (paths.length > 0) {
    for (let i = 0; i < spread; i++) users.push(new Map(digits(i).map((d, p) => [paths[p]?.key as string, paths[p]?.pool[d] as ClaimValue])));
    users.push(new Map(users[0]));
  }
  while (users.length < count) users.push(new Map());

  const findings: Finding[] = [];
  const unheld = paths.flatMap((p) => p.pool.filter((v) => !users.some((u) => u.has(p.key) && JSON.stringify(u.get(p.key)) === JSON.stringify(v))).map((v) => `${p.key}=${show(v)}`));
  if (unheld.length) findings.push({ status: "warn", check: "claims", detail: `${count} users cannot hold every value: no user holds ${unheld.join(", ")}` });
  if (combos > spread) {
    const held = new Set(users.filter((u) => u.size).map((u) => JSON.stringify([...u])));
    findings.push({ status: "warn", check: "claims", detail: `${combos} combinations of claim values, and ${count} users hold ${held.size} of them; rules that need values together may not be tested` });
  }
  return { paths, users, notSet, findings };
}

/** The create-user body's metadata for one user's values. */
export function metadataOf(paths: SetPath[], values: Map<string, ClaimValue>): Metadata {
  const out: Metadata = {};
  for (const p of paths) {
    if (!values.has(p.key)) continue;
    const [top, ...rest] = p.path as ["app_metadata" | "user_metadata", ...string[]];
    out[top] ??= {};
    let at = out[top];
    for (const k of rest.slice(0, -1)) {
      at[k] ??= {};
      at = at[k] as Record<string, unknown>;
    }
    at[rest.at(-1) as string] = values.get(p.key);
  }
  return out;
}

export const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? null));
