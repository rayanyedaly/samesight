/**
 * `samesight exposure --against <ref>` output: what a change to the sync configs, or to the
 * migrations under them, does to who receives which tables and columns, as text or JSON. It
 * says what the files show, as the map does: wider only where more users surely get
 * something, and never that a change is safe.
 */

import { type Audience, audienceText } from "../lint/audience.ts";
import { type ExposureDiff, type QueryChange, type TableDiff, type Unread, widens } from "./diff.ts";
import { columnText, MATCHED_BY } from "./format.ts";
import type { ExposureMap } from "./map.ts";

/** One sync config compared with the commit. */
export interface DiffedConfig {
  /** As the user named it. */
  file: string;
  diff: ExposureDiff;
  /** The map of the file as it is now, where the queries the diff names are placed. */
  after: ExposureMap;
  /** Where a query starts in the file as it is now; undefined when it cannot be placed. */
  lineOf: (sql: string) => { line: number } | undefined;
}

/** A labelled line of a block, its text lined up with the others'. */
const line = (label: string, text: string) => `  ${label.padEnd(16)}  ${text}`;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The text for each config, then one line saying what reaches more users than in the commit. */
export function formatExposureDiff(configs: DiffedConfig[], ref: string): string {
  const sections = configs.map((c) => configText(c, ref).join("\n\n"));
  return [...sections, summary(configs, ref), MATCHED_BY].join("\n\n");
}

function configText(c: DiffedConfig, ref: string): string[] {
  const { diff, file } = c;
  const head = `== ${file}, against ${ref} ==`;
  if (!diff.changed) return [head, "No change."];
  const kind = diff.kind ? [`Was ${kindName(diff.kind.before)}, now ${kindName(diff.kind.after)}.`] : [];
  const unread = [
    ...diff.unread.added.map((u) => `could not read: ${queryName(c, u)}: ${u.reason}`),
    ...diff.unread.removed.map((u) => `read now, could not before: ${u.stream}, ${u.query}`),
  ];
  return [head, ...kind, ...diff.tables.map((t) => tableText(c, t)), ...(unread.length ? [unread.join("\n")] : [])];
}

const kindName = (k: ExposureMap["kind"]) => (k === "streams" ? "sync streams" : "sync rules");

/** What happened to the table, in its title. */
function title(t: TableDiff): string {
  if (t.status === "added") return "newly sent";
  if (t.status === "removed") return "no longer sent";
  switch (t.audience.direction) {
    case "wider":
      return "reaches more users";
    case "narrower":
      return "reaches fewer users";
    case "changed":
      return "reaches other users";
    default:
      return widens(t) ? "sends more" : "changed";
  }
}

function tableText(c: DiffedConfig, t: TableDiff): string {
  const out = [`${t.table}: ${title(t)}`];
  const { before, after } = t.audience;
  if (t.status === "added" && after) out.push(line("to", audienceText(after)));
  else if (t.status === "removed" && before) out.push(line("was to", audienceText(before)));
  else if (t.audience.direction && before && after) out.push(line("was to", audienceText(before)), line("now to", audienceText(after)));

  for (const [to, names] of grouped(t.columns.added.map((col) => [col.audience, columnText(col)]))) out.push(line("columns added", `${names.join(", ")}: to ${to}`));
  // A column a * the schema did not know may have sent: listed because it now surely reaches more users.
  const maybe = t.columns.added.filter((col) => col.before);
  if (maybe.length) out.push(line("", `(${maybe.map((col) => col.name).join(", ")} may have been sent before by a * whose columns were not known)`));
  if (t.status !== "removed") {
    const dropped = t.columns.removed.map((col) => columnText(col));
    if (dropped.length) out.push(line("columns dropped", dropped.join(", ")));
  }
  // Columns that moved as the table did need only their names; others say from whom to whom.
  const tableChange = changeText(t.audience);
  for (const [direction, label] of [
    ["wider", "columns wider"],
    ["narrower", "columns narrower"],
    ["changed", "columns moved"],
  ] as const) {
    const byChange = new Map<string, string[]>();
    for (const col of t.columns.audience.filter((x) => x.change.direction === direction)) {
      const key = changeText(col.change);
      byChange.set(key, [...(byChange.get(key) ?? []), columnText(col)]);
    }
    for (const [change, names] of byChange) out.push(line(label, change === tableChange ? names.join(", ") : `${names.join(", ")}: ${change}`));
  }
  for (const p of t.columns.personal) {
    const tag = (m: typeof p.before) => (m ? `${m.category}${m.source === "comment" ? ", marked in its comment" : ", by its name"}` : "not personal");
    out.push(line("personal", `${p.name}: was ${tag(p.before)}, now ${tag(p.after)}`));
  }

  if (t.status === "changed") {
    for (const q of t.queries.added) out.push(line("query added", `${queryName(c, q)}: to ${audienceText(q.audience)}`));
    for (const q of t.queries.removed) out.push(line("query dropped", `${q.stream}, ${q.query}: was to ${audienceText(q.audience)}`));
  }
  for (const q of t.queries.changed) out.push(...changedQuery(c, t, q));
  return out.join("\n");
}

/** An audience change in words, or "" when a side is missing. */
const changeText = (c: { before?: Audience; after?: Audience }) => (c.before && c.after ? `was to ${audienceText(c.before)}, now to ${audienceText(c.after)}` : "");

/** Columns grouped by the audience they reach, in the order first met. */
function grouped(items: [Audience, string][]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [audience, name] of items) {
    const key = audienceText(audience);
    out.set(key, [...(out.get(key) ?? []), name]);
  }
  return out;
}

/** A query as the file now places it: stream, label, file and line. */
function queryName(c: DiffedConfig, q: { stream: string; query: string; sql: string }): string {
  const at = c.lineOf(q.sql);
  return `${q.stream}, ${q.query}  (${at ? `${c.file}:${at.line}` : c.file})`;
}

function changedQuery(c: DiffedConfig, t: TableDiff, q: QueryChange): string[] {
  const now = c.after.tables.find((x) => x.table === t.table)?.queries.find((x) => x.stream === q.stream && x.query === q.query.after);
  const label = q.query.before === q.query.after ? q.query.after : `${q.query.after} (was ${q.query.before})`;
  const out = [line("query edited", now ? queryName(c, { ...now, query: label }) : `${q.stream}, ${label}`)];
  if (q.sql) out.push(line("", `was  ${oneLine(q.sql.before)}`), line("", `now  ${oneLine(q.sql.after)}`));
  if (q.audience?.before && q.audience.after) out.push(line("", `was to ${audienceText(q.audience.before)}; now to ${audienceText(q.audience.after)}`));
  for (const d of q.decidedBy ?? []) {
    if (d.before !== undefined && d.after !== undefined) out.push(line("", `${d.name} was  ${oneLine(d.before)}`), line("", `${d.name} now  ${oneLine(d.after)}`));
    else if (d.after !== undefined) out.push(line("", `${d.name} added  ${oneLine(d.after)}`));
    else if (d.before !== undefined) out.push(line("", `${d.name} dropped  ${oneLine(d.before)}`));
  }
  if (q.autoSubscribe) out.push(line("", q.autoSubscribe.after ? "now sent to every device without the app asking" : "now sent only when the app subscribes"));
  if (q.columns?.added.length) out.push(line("", `sends now: ${q.columns.added.join(", ")}`));
  if (q.columns?.removed.length) out.push(line("", `no longer sends: ${q.columns.removed.join(", ")}`));
  return out;
}

/** SQL on one line, so the block stays one entry per line. */
const oneLine = (sql: string) => sql.replace(/[\p{Cc}\u2028\u2029\s]+/gu, " ").trim();

/** What reaches more users than in the commit, over every config; never that the rest is safe. */
function summary(configs: DiffedConfig[], ref: string): string {
  const wider = configs.flatMap((c) => c.diff.tables.filter(widens).map((t) => (configs.length > 1 ? `${t.table} (${c.file})` : t.table)));
  const unread = configs.reduce((n, c) => n + c.diff.unread.added.length, 0);
  const lost = unread ? `${count(unread, "query", "queries")} that cannot be read ${unread === 1 ? "is" : "are"} new since ${ref}, and may send anything.` : "";
  if (wider.length) return `${count(wider.length, "table")} ${wider.length === 1 ? "reaches" : "reach"} more users, or more columns, than in ${ref}: ${wider.join(", ")}.${lost ? ` ${lost}` : ""}`;
  if (unread) return `No table is known to reach more users than in ${ref}, but ${lost.charAt(0).toLowerCase()}${lost.slice(1)}`;
  const changed = configs.reduce((n, c) => n + c.diff.tables.length, 0);
  if (changed || configs.some((c) => c.diff.changed)) return `Nothing reaches more users than in ${ref}, as far as the files show; ${count(changed, "table")} changed otherwise.`;
  return `No change in who receives which tables and columns since ${ref}.`;
}

/** The JSON report: each config's diff, the queries the files now place given their line. */
export function exposureDiffJson(
  configs: DiffedConfig[],
  run: { ref: string; commit: string; files: string[]; migrations: string | null; unreadable: { file: string; error: string }[] },
) {
  return {
    version: 1,
    against: { ref: run.ref, commit: run.commit },
    files: run.files,
    migrations: run.migrations,
    widened: configs.some((c) => c.diff.widened),
    changed: configs.some((c) => c.diff.changed),
    diffs: configs.map((c) => {
      const at = (sql: string) => {
        const p = c.lineOf(sql);
        return p ? { line: p.line } : {};
      };
      return {
        file: c.file,
        ...c.diff,
        tables: c.diff.tables.map((t) => ({ ...t, queries: { ...t.queries, added: t.queries.added.map((q) => ({ ...q, ...at(q.sql) })) } })),
        unread: { added: c.diff.unread.added.map((u: Unread) => ({ ...u, ...at(u.sql) })), removed: c.diff.unread.removed },
      };
    }),
    unreadable: run.unreadable,
  };
}
