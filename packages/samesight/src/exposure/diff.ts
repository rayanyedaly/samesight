/**
 * What a change to a sync config, or to the migrations under it, changes in the exposure
 * map: tables newly sent or no longer sent, who receives each table, column and query, the
 * columns sent, and those that likely hold personal data. Two maps in, the differences out,
 * with nothing read from disk; a map parsed back from `samesight exposure --format json`
 * compares the same way.
 *
 * It says "wider" only where the change surely reaches more users, and counts a change as
 * widening only then: a change it cannot rank (a role check for a group) is listed as changed,
 * never as wider or narrower.
 */

import { type Audience, widest } from "../lint/audience.ts";
import { render, tokenize } from "../sync/sql.ts";
import type { ExposedQuery, ExposureMap } from "./map.ts";
import type { PersonalMatch } from "./personal.ts";

/** A map as `exposureMap` returns it, or as `samesight exposure --format json` prints it. */
export type MapLike = Pick<ExposureMap, "kind" | "tables" | "unread">;

/** How an audience changed: to surely more users, surely fewer, or neither for sure. */
export type Direction = "wider" | "narrower" | "changed";

/** Who received something before and after; `direction` when both are there and differ. */
export interface AudienceChange {
  before?: Audience;
  after?: Audience;
  direction?: Direction;
}

export interface QueryRef {
  stream: string;
  query: string;
  sql: string;
  audience: Audience;
  autoSubscribe: boolean;
}

/** A query found on both sides (same stream, and the same SQL or the same label) that differs in more than its label. */
export interface QueryChange {
  stream: string;
  query: { before: string; after: string };
  /** When the SQL differs, apart from spacing and the case of words. */
  sql?: { before: string; after: string };
  audience?: AudienceChange;
  autoSubscribe?: { before: boolean; after: boolean };
  /** Device column names it sends now and did not, and the reverse. */
  columns: { added: string[]; removed: string[] };
}

export interface ColumnAdded {
  name: string;
  /** The widest audience over the queries that now send it. */
  audience: Audience;
  personal?: PersonalMatch;
}

export interface ColumnRemoved {
  name: string;
  /** The widest audience over the queries that sent it. */
  audience: Audience;
  personal?: PersonalMatch;
}

export interface TableDiff {
  table: string;
  status: "added" | "removed" | "changed";
  /** The widest audience over the table's queries (on-demand ones too: a client that subscribes gets them). */
  audience: AudienceChange;
  columns: {
    /** Sent now and not before; only listed when the columns before are known. */
    added: ColumnAdded[];
    /** Sent before and not now; only listed when the columns now are known. */
    removed: ColumnRemoved[];
    /** Sent before and now, to a different audience (the widest over the queries that send it). */
    audience: { name: string; personal?: PersonalMatch; change: AudienceChange }[];
    /** Sent before and now, and marked or matched as personal differently (a comment marker added, say). */
    personal: { name: string; before?: PersonalMatch; after?: PersonalMatch }[];
    /** False on a side where some query's * read a table no schema there knows, or knows only in part. */
    known: { before: boolean; after: boolean };
  };
  queries: { added: QueryRef[]; removed: QueryRef[]; changed: QueryChange[] };
}

export type Unread = MapLike["unread"][number];

export interface ExposureDiff {
  /** Whether anything below is listed. */
  changed: boolean;
  /**
   * Whether something below surely reaches more users: a table or column sent that was not,
   * a table, column or query whose audience is wider, a query that can no longer be read, or
   * columns that could be read before and cannot now. Never true without such an entry.
   */
  widened: boolean;
  /** When one side is sync streams and the other sync rules. */
  kind?: { before: MapLike["kind"]; after: MapLike["kind"] };
  /** Tables with a change, sorted by name. */
  tables: TableDiff[];
  /** Queries that cannot be read, by stream and SQL: new ones, and ones that can be read now. */
  unread: { added: Unread[]; removed: Unread[] };
}

/** Who receives what in `after` that differs from `before`. */
export function diffExposure(before: MapLike, after: MapLike): ExposureDiff {
  const old = new Map(before.tables.map((t) => [t.table, t.queries]));
  const now = new Map(after.tables.map((t) => [t.table, t.queries]));
  const names = [...new Set([...old.keys(), ...now.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tables = names.map((name) => tableDiff(name, old.get(name) ?? [], now.get(name) ?? [])).filter((t): t is TableDiff => t !== undefined);

  const key = (u: Unread) => `${u.stream}\0${normal(u.sql)}`;
  const oldUnread = new Set(before.unread.map(key));
  const newUnread = new Set(after.unread.map(key));
  const unread = { added: after.unread.filter((u) => !oldUnread.has(key(u))), removed: before.unread.filter((u) => !newUnread.has(key(u))) };

  const kind = before.kind === after.kind ? undefined : { before: before.kind, after: after.kind };
  const widened = unread.added.length > 0 || tables.some(widens);
  const changed = kind !== undefined || tables.length > 0 || unread.added.length > 0 || unread.removed.length > 0;
  return { changed, widened, ...(kind ? { kind } : {}), tables, unread };
}

/** Whether a table's entry holds something that surely reaches more users. */
function widens(t: TableDiff): boolean {
  return (
    t.status === "added" ||
    t.audience.direction === "wider" ||
    t.columns.added.length > 0 ||
    t.columns.audience.some((c) => c.change.direction === "wider") ||
    t.queries.changed.some((q) => q.audience?.direction === "wider") ||
    (t.columns.known.before && !t.columns.known.after)
  );
}

function tableDiff(table: string, before: ExposedQuery[], after: ExposedQuery[]): TableDiff | undefined {
  const pairs = matchQueries(before, after);
  const matchedBefore = new Set(pairs.map(([b]) => b));
  const matchedAfter = new Set(pairs.map(([, a]) => a));
  const queries = {
    added: after.filter((q) => !matchedAfter.has(q)).map(ref),
    removed: before.filter((q) => !matchedBefore.has(q)).map(ref),
    changed: pairs.map(([b, a]) => queryChange(b, a)).filter((q): q is QueryChange => q !== undefined),
  };

  const audience = tableAudience(before, after, pairs, queries);
  const columns = columnsDiff(before, after);
  const status = !before.length ? "added" : !after.length ? "removed" : "changed";
  const empty =
    status === "changed" &&
    !audience.direction &&
    !queries.added.length &&
    !queries.removed.length &&
    !queries.changed.length &&
    !columns.added.length &&
    !columns.removed.length &&
    !columns.audience.length &&
    !columns.personal.length &&
    columns.known.before === columns.known.after;
  return empty ? undefined : { table, status, audience, columns, queries };
}

/**
 * The table's widest audience on each side. Beyond what the two audiences alone say, a table
 * that still sends every query it did, each to the same users or more, and sends more queries
 * besides, reaches more users (and the reverse fewer): who gets its rows is the union over
 * its queries.
 */
function tableAudience(before: ExposedQuery[], after: ExposedQuery[], pairs: [ExposedQuery, ExposedQuery][], queries: TableDiff["queries"]): AudienceChange {
  const b = before.length ? widest(before.map((q) => q.audience)) : undefined;
  const a = after.length ? widest(after.map((q) => q.audience)) : undefined;
  if (!b || !a) return { ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) };
  if (sameAudience(b, a)) return { before: b, after: a };
  let direction = compareAudience(b, a);
  if (direction === "changed") {
    const each = pairs.map(([x, y]) => (sameAudience(x.audience, y.audience) ? "same" : compareAudience(x.audience, y.audience)));
    if (!queries.removed.length && queries.added.length && each.every((d) => d === "same" || d === "wider")) direction = "wider";
    else if (!queries.added.length && queries.removed.length && each.every((d) => d === "same" || d === "narrower")) direction = "narrower";
  }
  return { before: b, after: a, direction };
}

/**
 * Whether `after` surely reaches more users than `before`, surely fewer, or neither for sure.
 * Every user for every row is wider than anything short of it but a client's pick (any
 * client can ask for any row, so that may already reach every user); a group is wider than
 * the row's owner. The rest cannot be ranked from the files alone.
 */
export function compareAudience(before: Audience, after: Audience): Direction {
  const all = (x: Audience) => x.kind === "everyone" && !x.mixed;
  if (all(after) && !all(before) && before.kind !== "client") return "wider";
  if (all(before) && !all(after) && after.kind !== "client") return "narrower";
  if (before.kind === "owner" && after.kind === "group") return "wider";
  if (before.kind === "group" && after.kind === "owner") return "narrower";
  return "changed";
}

/** Whether two audiences reach the same users, as the map names them. */
export function sameAudience(x: Audience, y: Audience): boolean {
  switch (x.kind) {
    case "owner":
      return y.kind === "owner" && x.column === y.column && x.parent?.table === y.parent?.table && x.parent?.column === y.parent?.column;
    case "group":
      return y.kind === "group" && x.via === y.via;
    case "everyone":
      return y.kind === "everyone" && Boolean(x.mixed) === Boolean(y.mixed);
    default:
      return x.kind === y.kind;
  }
}

/** SQL as the tokenizer reads it: spacing, comments and the case of words do not count. */
function normal(sql: string): string {
  try {
    return render(tokenize(sql));
  } catch {
    return sql.trim().replace(/\s+/g, " ");
  }
}

/**
 * The queries found on both sides: first those of the same stream with the same SQL (a query
 * that only moved, so its label changed), then those of the same stream with the same label
 * (a query edited in place).
 */
function matchQueries(before: ExposedQuery[], after: ExposedQuery[]): [ExposedQuery, ExposedQuery][] {
  const pairs: [ExposedQuery, ExposedQuery][] = [];
  const left = new Set(before);
  const pass = (same: (b: ExposedQuery, a: ExposedQuery) => boolean) => {
    for (const a of after) {
      if (pairs.some(([, y]) => y === a)) continue;
      const b = [...left].find((x) => x.stream === a.stream && same(x, a));
      if (b) {
        pairs.push([b, a]);
        left.delete(b);
      }
    }
  };
  pass((b, a) => normal(b.sql) === normal(a.sql));
  pass((b, a) => b.query === a.query);
  // In the after map's order, for a stable result.
  return pairs.sort(([, x], [, y]) => after.indexOf(x) - after.indexOf(y));
}

const ref = (q: ExposedQuery): QueryRef => ({ stream: q.stream, query: q.query, sql: q.sql, audience: q.audience, autoSubscribe: q.autoSubscribe });

function queryChange(b: ExposedQuery, a: ExposedQuery): QueryChange | undefined {
  const names = (q: ExposedQuery) => q.columns.items.map((c) => c.name);
  const [was, is] = [names(b), names(a)];
  const columns = { added: is.filter((n) => !was.includes(n)), removed: was.filter((n) => !is.includes(n)) };
  const sql = normal(b.sql) === normal(a.sql) ? undefined : { before: b.sql, after: a.sql };
  const audience = sameAudience(b.audience, a.audience) ? undefined : { before: b.audience, after: a.audience, direction: compareAudience(b.audience, a.audience) };
  const autoSubscribe = b.autoSubscribe === a.autoSubscribe ? undefined : { before: b.autoSubscribe, after: a.autoSubscribe };
  // A label alone that changed (a query inserted before it) sends nothing new.
  if (!sql && !audience && !autoSubscribe && !columns.added.length && !columns.removed.length) return undefined;
  return {
    stream: a.stream,
    query: { before: b.query, after: a.query },
    ...(sql ? { sql } : {}),
    ...(audience ? { audience } : {}),
    ...(autoSubscribe ? { autoSubscribe } : {}),
    columns,
  };
}

interface Sent {
  audience: Audience;
  personal?: PersonalMatch;
}

/** A side's columns by device name, each with the widest audience over the queries that send it, and whether all are known. */
function sentColumns(queries: ExposedQuery[]): { columns: Map<string, Sent>; known: boolean } {
  const audiences = new Map<string, Audience[]>();
  const personal = new Map<string, PersonalMatch>();
  let known = true;
  for (const q of queries) {
    if (q.columns.source === "unknown" || !q.columns.complete) known = false;
    for (const c of q.columns.items) {
      audiences.set(c.name, [...(audiences.get(c.name) ?? []), q.audience]);
      if (c.personal && !personal.has(c.name)) personal.set(c.name, c.personal);
    }
  }
  const columns = new Map([...audiences].map(([name, a]): [string, Sent] => [name, { audience: widest(a), ...(personal.has(name) ? { personal: personal.get(name) } : {}) }]));
  return { columns, known };
}

function columnsDiff(before: ExposedQuery[], after: ExposedQuery[]): TableDiff["columns"] {
  const b = sentColumns(before);
  const a = sentColumns(after);
  const added: ColumnAdded[] = [];
  const audience: TableDiff["columns"]["audience"] = [];
  const personal: TableDiff["columns"]["personal"] = [];
  for (const [name, now] of a.columns) {
    const was = b.columns.get(name);
    if (!was) {
      // A column a * may have sent before, unseen, is not known to be new.
      if (b.known) added.push({ name, ...now });
      continue;
    }
    if (!sameAudience(was.audience, now.audience)) {
      audience.push({ name, ...(now.personal ? { personal: now.personal } : {}), change: { before: was.audience, after: now.audience, direction: compareAudience(was.audience, now.audience) } });
    }
    if (!samePersonal(was.personal, now.personal)) personal.push({ name, ...(was.personal ? { before: was.personal } : {}), ...(now.personal ? { after: now.personal } : {}) });
  }
  const removed: ColumnRemoved[] = a.known ? [...b.columns].filter(([name]) => !a.columns.has(name)).map(([name, was]) => ({ name, ...was })) : [];
  return { added, removed, audience, personal, known: { before: b.known, after: a.known } };
}

const samePersonal = (x: PersonalMatch | undefined, y: PersonalMatch | undefined) =>
  x === undefined || y === undefined ? x === y : x.category === y.category && x.matched === y.matched && x.source === y.source;
