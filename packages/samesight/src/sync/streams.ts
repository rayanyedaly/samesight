/**
 * The streams of an Edition 3 sync config, read in full or refused: lint, audit and the
 * verifier's stream checks all start from this.
 */

import { parse } from "yaml";

export interface Stream {
  name: string;
  ctes: Map<string, string>;
  /** Devices subscribe without being asked (auto_subscribe: true). */
  autoSubscribe: boolean;
  /** Labelled as the config names them: "query", or "queries[n]". */
  queries: { label: string; sql: string }[];
}

/** Keys this check reads or knows to carry no SQL. Anything else is refused, not skipped. */
const TOP_LEVEL = new Set(["config", "streams"]);
const STREAM_KEYS = new Set(["auto_subscribe", "priority", "with", "query", "queries"]);

/** The streams of an Edition 3 sync config; throws on anything it cannot read in full. */
export function parseStreams(yaml: string): Stream[] {
  const doc = parse(yaml) as unknown;
  if (!isObject(doc)) throw new Error("the sync config is not a YAML mapping");
  const unknown = Object.keys(doc).filter((k) => !TOP_LEVEL.has(k));
  if (unknown.length) throw new Error(`the sync config has ${unknown.join(", ")}, which this check does not read; only streams are supported`);
  if (!isObject(doc.streams)) throw new Error("the sync config has no streams: section");
  return Object.entries(doc.streams).map(([name, s]) => {
    if (!isObject(s)) throw new Error(`stream ${name} is not a mapping`);
    const extra = Object.keys(s).filter((k) => !STREAM_KEYS.has(k));
    if (extra.length) throw new Error(`stream ${name} has ${extra.join(", ")}, which this check does not read`);
    const ctes = s.with ?? {};
    if (!isObject(ctes) || !Object.values(ctes).every((v) => typeof v === "string")) throw new Error(`stream ${name}: with must map names to SQL strings`);
    if (s.query !== undefined && typeof s.query !== "string") throw new Error(`stream ${name}: query must be a SQL string`);
    if (s.queries !== undefined && !(Array.isArray(s.queries) && s.queries.every((q) => typeof q === "string"))) {
      throw new Error(`stream ${name}: queries must be a list of SQL strings`);
    }
    return {
      name,
      autoSubscribe: s.auto_subscribe === true,
      ctes: new Map(Object.entries(ctes as Record<string, string>)),
      queries: [
        ...(s.query !== undefined ? [{ label: "query", sql: s.query as string }] : []),
        ...((s.queries ?? []) as string[]).map((sql, n) => ({ label: `queries[${n}]`, sql })),
      ],
    };
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
