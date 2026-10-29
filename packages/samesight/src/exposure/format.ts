/**
 * `samesight exposure` output: the exposure map of one or more sync configs as text, one
 * block per table (which queries send it, to whom, which columns), or as JSON. It says what
 * the files show, as the map does: a column looks personal by its name or a comment marker,
 * never by its data.
 */

import { audienceText } from "../lint/audience.ts";
import type { ExposedColumn, ExposedQuery, ExposureMap } from "./map.ts";

/** One sync config's map, as the CLI read it. */
export interface MappedConfig {
  /** As the user named it. */
  file: string;
  map: ExposureMap;
  /** Where a query starts in the file (lint's lineFinder); undefined when it cannot be placed. */
  lineOf: (sql: string) => { line: number } | undefined;
}

export interface FormatOptions {
  /** Whether migrations were read: without them, no one here knows the columns a * sends. */
  migrations: boolean;
}

/** The last line of the text, whatever the map shows. */
export const MATCHED_BY = "Columns are matched by name or a samesight comment marker, never by their data.";

/**
 * The text for each map: a block per table, in the map's order, the queries it could not
 * read, and a summary of the likely personal columns that reach users other than the row's
 * owner. Several configs each get a `== file ==` header.
 */
export function formatExposure(configs: MappedConfig[], options: FormatOptions): string {
  const header = configs.length > 1;
  const sections = configs.map((c) => [...(header ? [`== ${c.file} ==`] : []), ...configText(c, options)].join("\n\n"));
  return [...(sections.length ? [sections.join("\n\n")] : []), MATCHED_BY].join("\n");
}

/** The JSON report: each map's own objects, each query given the line it starts on when found. */
export function exposureJson(configs: MappedConfig[], run: { files: string[]; migrations: string | null; unreadable: { file: string; error: string }[] }) {
  return {
    version: 1,
    files: run.files,
    migrations: run.migrations,
    maps: configs.map(({ file, map, lineOf }) => {
      const at = (sql: string) => {
        const p = lineOf(sql);
        return p ? { line: p.line } : {};
      };
      return {
        file,
        kind: map.kind,
        tables: map.tables.map((t) => ({ ...t, queries: t.queries.map((q) => ({ ...q, ...at(q.sql) })) })),
        unread: map.unread.map((u) => ({ ...u, ...at(u.sql) })),
      };
    }),
    unreadable: run.unreadable,
  };
}

/** One config's blocks, its unread queries as one block, and its summary. */
function configText({ file, map, lineOf }: MappedConfig, options: FormatOptions): string[] {
  const kind = map.kind === "streams" ? "stream" : "bucket";
  const place = (sql: string) => {
    const p = lineOf(sql);
    return p ? `${file}:${p.line}` : file;
  };
  const blocks = map.tables.map((t) =>
    [
      t.table,
      ...t.queries.flatMap((q) => {
        const when = q.autoSubscribe ? "" : ", when the app subscribes";
        // PowerSync names the device's table after an alias: FROM todos t sends rows of t.
        const as = q.deviceTable === t.table ? "" : `, as ${q.deviceTable} on devices`;
        // A bucket reaches users through each parameter query, after the widest of them.
        const through = q.paths.length > 1 ? q.paths.map((p) => field("", `through ${p.via}: ${pathText(p)}`)) : [];
        return [
          field("sent by", `${kind} ${q.stream}, ${q.query}${when}${as}  (${place(q.sql)})`),
          field("to", audienceText(q.audience)),
          ...through,
          field("columns", columnsText(q, map.kind, options)),
        ];
      }),
    ].join("\n"),
  );
  const unread = map.unread.map((u) => `could not read: ${kind} ${u.stream}, ${u.query} (${place(u.sql)}): ${u.reason}`);
  return [...blocks, ...(unread.length ? [unread.join("\n")] : []), summary(map)];
}

/** A labelled line of a block, its text lined up with the others'. */
const field = (label: string, text: string) => `  ${label.padEnd(7)}  ${text}`;

/** Who a bucket reaches through one parameter query, without naming that query twice. */
function pathText(p: ExposedQuery["paths"][number]): string {
  const text = audienceText(p.audience);
  const tail = `, through ${p.via}`;
  return text.endsWith(tail) ? text.slice(0, -tail.length) : text;
}

/** The columns a query sends, and where the list comes from when a * sends them. */
function columnsText(q: ExposedQuery, kind: ExposureMap["kind"], options: FormatOptions): string {
  const { source, complete, items } = q.columns;
  const listed = items.map(columnText).join(", ");
  if (source === "list") return listed || "none";
  if (source === "unknown") {
    const why = options.migrations ? "the migrations do not define it" : "no migrations read";
    return `all columns (${why}, so not known)${listed ? `, plus ${listed}` : ""}`;
  }
  if (!complete) return listed ? `${listed}, and maybe more (the migrations define it in part)` : "all columns (the migrations define it in part, so not known)";
  // Sync rules' * leaves out columns whose names start with _, as the map does.
  return `${listed || "none"}  (${kind === "streams" ? "all columns" : "all columns not starting with _"}, from the migrations)`;
}

/**
 * A column by its name on the device; the table's columns it is read from, when the name
 * does not show them (who, from full_name); and why it looks personal.
 */
function columnText(c: ExposedColumn): string {
  const from = c.from.some((f) => !shows(c.name, f)) ? ` (from ${c.from.join(", ")})` : "";
  const personal = c.personal ? ` [${c.personal.category}${c.personal.source === "comment" ? ", marked in its comment" : ""}]` : "";
  return `${c.name}${from}${personal}`;
}

/** Whether a name holds a column's name as a whole word, in any case: email in lower(email), "my col" in "my col". */
function shows(name: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "iu").test(name);
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A personal column as the summary names it: by the table's column the match was made on
 * (members.email, or members.email as contact), else by the columns it reads and its name on
 * the device (profiles.title as email, profiles.data as phone).
 */
function personalName(table: string, c: ExposedColumn): string {
  if (c.matchedOn !== undefined) return c.matchedOn === c.name && !c.derived ? `${table}.${c.name}` : `${table}.${c.matchedOn} as ${c.name}`;
  return `${c.from.map((f) => `${table}.${f}`).join(" and ")} as ${c.name}`;
}

/**
 * How many tables, and the likely personal columns that reach users other than the row's
 * owner (any audience but "owner"), one per column sent. Where some of what those users get
 * is not known (a query not read, a * with no columns to read), it claims no more than it read.
 */
function summary(map: ExposureMap): string {
  const shared = map.tables.flatMap((t) => t.queries.filter((q) => q.audience.kind !== "owner").map((q) => ({ table: t.table, q })));
  const personal = [...new Set(shared.flatMap(({ table, q }) => q.columns.items.filter((c) => c.personal).map((c) => personalName(table, c))))];
  const unknown = [...new Set(shared.filter(({ q }) => !q.columns.complete).map(({ table }) => table))];
  const unread = map.unread.length ? `, and ${count(map.unread.length, "query", "queries")} that could not be read` : "";
  const found = personal.length
    ? `${count(personal.length, "likely personal column")} ${personal.length === 1 ? "reaches" : "reach"} users other than the row's owner: ${personal.join(", ")}.`
    : `No column ${unknown.length || map.unread.length ? "known here " : ""}that looks personal reaches users other than the row's owner.`;
  const partial = unknown.length ? ` Not every column sent from ${unknown.join(", ")} is known.` : "";
  return `${count(map.tables.length, "table")}${unread}. ${found}${partial}`;
}
