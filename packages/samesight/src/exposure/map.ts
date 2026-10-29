/**
 * The exposure map of a sync config: for each table it sends, which queries send it, who
 * receives the rows (lint/audience.ts), and which columns, with the ones that likely hold
 * personal data marked (personal.ts). Read from the sync config and, when given, the
 * migrations' schema, which is what a SELECT * sends; nothing connects to a database. It
 * says what the files say, as lint does: `samesight-verify audit` tests the rows.
 */

import { type Audience, bucketAudiences, streamAudience, widest } from "../lint/audience.ts";
import { sentColumns } from "../sync/columns.ts";
import type { SyncConfig } from "../sync/config.ts";
import { commentMarker, type PersonalMatch, personalColumn } from "./personal.ts";

/** A table as the schema knows it: the migrations' TableDef fits, and so can a live database's. */
export interface SchemaTable {
  columns: { name: string; type?: string; comment?: string }[];
  primaryKey: string[];
  /** False when some of its columns may be missing here (LIKE, INHERITS, CREATE TABLE AS). */
  complete: boolean;
}

/** The schema's tables by name, or undefined when there is no schema (no migrations read). */
export type Schema = (table: string) => SchemaTable | undefined;

export interface ExposedColumn {
  /** The column's name on the device. */
  name: string;
  /** The table's columns its value comes from; [] for a literal. */
  from: string[];
  /** Anything but a bare column: lower(email), data ->> 'phone'. */
  derived: boolean;
  /** When it likely holds personal data, by its name or a comment marker. */
  personal?: PersonalMatch;
  /** The JSON key the match was made on, when it was (data ->> 'phone'): not the column's name. */
  jsonKey?: string;
}

export interface ExposedQuery {
  /** The stream, or the sync rules bucket. */
  stream: string;
  /** As the config names it: query, queries[n], data[n]. */
  query: string;
  sql: string;
  /** Devices get it without asking (always so for buckets). */
  autoSubscribe: boolean;
  /** The table's name on the device, when an alias renames it. */
  deviceTable: string;
  /** Who receives the rows: the widest of `paths`. */
  audience: Audience;
  /** For a bucket, the audience through each parameter query; for a stream, its one audience. */
  paths: { via?: string; audience: Audience }[];
  columns: {
    /** "list": the query names every column; "schema": * read from the migrations; "unknown": * with no schema to read. */
    source: "list" | "schema" | "unknown";
    /** False when * reads a table the schema knows only in part. */
    complete: boolean;
    items: ExposedColumn[];
  };
}

export interface ExposedTable {
  table: string;
  queries: ExposedQuery[];
}

export interface ExposureMap {
  kind: SyncConfig["kind"];
  /** Sorted by table name; each table's queries in config order. */
  tables: ExposedTable[];
  /** Queries whose table or audience cannot be read, with why: unreadable-query names the same ones. */
  unread: { stream: string; query: string; sql: string; reason: string }[];
}

/**
 * The exposure map of a parsed sync config. `schema` gives the columns a * sends; without it,
 * a * is "unknown" and only listed columns are read.
 */
export function exposureMap(config: SyncConfig, schema?: Schema): ExposureMap {
  // A table the schema knows keys by its primary key, none included: then no row of it is one
  // user's through a join. Only a table it does not know is taken to be keyed by id.
  const keys = (table: string) => schema?.(table)?.primaryKey;
  const byTable = new Map<string, ExposedQuery[]>();
  const unread: ExposureMap["unread"] = [];
  for (const s of config.streams) {
    const buckets = config.kind === "bucket definitions" ? bucketAudiences(s.ctes, s.queries, keys) : undefined;
    for (const q of s.queries) {
      const at = { stream: s.name, query: q.label, sql: q.sql };
      let sent: ReturnType<typeof sentColumns>;
      try {
        sent = sentColumns(q.sql);
      } catch (e) {
        unread.push({ ...at, reason: (e as Error).message });
        continue;
      }
      const paths = buckets ? buckets.get(q.label) : streamPaths(q.sql, s.ctes, keys);
      if (!paths?.length) {
        unread.push({ ...at, reason: "who receives its rows cannot be read" });
        continue;
      }
      const exposed: ExposedQuery = {
        ...at,
        autoSubscribe: s.autoSubscribe,
        deviceTable: sent.deviceTable,
        audience: widest(paths.map((p) => p.audience)),
        paths,
        columns: columnsOf(sent, config.kind, schema?.(sent.table), sent.table),
      };
      byTable.set(sent.table, [...(byTable.get(sent.table) ?? []), exposed]);
    }
  }
  const tables = [...byTable].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([table, queries]) => ({ table, queries }));
  return { kind: config.kind, tables, unread };
}

function streamPaths(sql: string, ctes: Map<string, string>, keys: (table: string) => string[] | undefined): ExposedQuery["paths"] | undefined {
  const audience = streamAudience(sql, ctes, keys);
  return audience ? [{ audience }] : undefined;
}

/**
 * The columns a query sends, each checked for personal data: by the table's own column it
 * reads when there is one (lower(email) is still the email), else by its name on the device
 * (data ->> 'phone' AS phone), else by the JSON key it picks. A literal holds nobody's data.
 */
function columnsOf(sent: ReturnType<typeof sentColumns>, kind: SyncConfig["kind"], table: SchemaTable | undefined, name: string): ExposedQuery["columns"] {
  const known = new Map((table?.columns ?? []).map((c) => [c.name, c]));
  const siblings = table ? table.columns.map((c) => c.name) : sent.columns.flatMap((c) => c.from);
  const personal = (column: string, from: string[], jsonKeys: string[]): Pick<ExposedColumn, "personal" | "jsonKey"> => {
    if (!from.length) return {};
    // Columns marked not personal settle it, whatever they are renamed to; only when all are.
    let settled = true;
    for (const source of from) {
      const c = known.get(source);
      const match = personalColumn(source, name, { siblings, ...(c?.type ? { type: c.type } : {}), ...(c?.comment ? { comment: c.comment } : {}) });
      if (match) return { personal: match };
      if (!(c?.comment && commentMarker(c.comment)?.personal === false)) settled = false;
    }
    if (settled) return {};
    const byName = personalColumn(column, name, { siblings });
    if (byName) return { personal: byName };
    for (const key of jsonKeys) {
      const match = personalColumn(key, name, { siblings });
      if (match) return { personal: match, jsonKey: key };
    }
    return {};
  };
  const listed: ExposedColumn[] = sent.columns.map((c) => ({ name: c.name, from: c.from, derived: c.derived, ...personal(c.name, c.from, c.jsonKeys) }));
  if (!sent.star) return { source: "list", complete: true, items: listed };
  if (!table) return { source: "unknown", complete: false, items: listed };
  // Sync rules' * leaves out columns whose names start with _; Edition 3 streams send them.
  const all = table.columns.filter((c) => kind === "streams" || !c.name.startsWith("_"));
  const starred = all.filter((c) => !listed.some((l) => l.name === c.name)).map((c): ExposedColumn => ({ name: c.name, from: [c.name], derived: false, ...personal(c.name, [c.name], []) }));
  return { source: "schema", complete: table.complete, items: [...starred, ...listed] };
}
