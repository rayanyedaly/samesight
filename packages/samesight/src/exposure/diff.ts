/**
 * What a change to a sync config, or to the migrations under it, changes in the exposure
 * map: tables newly sent or no longer sent, who receives each table, column and query, the
 * columns sent, and those that likely hold personal data. Two maps in, the differences out,
 * with nothing read from disk; each map of `samesight exposure --format json` compares the
 * same way.
 *
 * It calls a change wider only where everyone who received something still does and more
 * users now surely do, and narrower only in the mirror case. Any other change of audience (a
 * role check for a group, a row's owner for a group, one owner column for another, another
 * owner column added) is listed as changed, never ranked. Queries that cannot be read, and a
 * * the schema does not know, may send anything, so a table and its columns are not ranked
 * against them; a query's own audience still is, against what that query sent before.
 */

import { type Audience, widest } from "../lint/audience.ts";
import { render, tokenize } from "../sync/sql.ts";
import type { ExposedQuery, ExposureMap } from "./map.ts";
import type { PersonalMatch } from "./personal.ts";

/** A map as `exposureMap` returns it, or one of the `maps` that `samesight exposure --format json` prints. */
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

/** A query found on both sides that differs in more than its label. */
export interface QueryChange {
  stream: string;
  query: { before: string; after: string };
  /** When the SQL differs, apart from spacing, comments and the case of words. */
  sql?: { before: string; after: string };
  /** The CTEs or parameter queries that decide who a group is, where they differ (one side missing when added or dropped). */
  decidedBy?: { name: string; before?: string; after?: string }[];
  audience?: AudienceChange;
  autoSubscribe?: { before: boolean; after: boolean };
  /** Device column names it sends now and did not, and the reverse; only when both sides' columns are known. */
  columns?: { added: string[]; removed: string[] };
}

export interface ColumnAdded {
  name: string;
  /** The table's columns its value comes from: a column renamed, or fed from another column, is another column. */
  from: string[];
  /** The widest audience over the queries that now send it. */
  audience: Audience;
  personal?: PersonalMatch;
  /**
   * When a * the schema did not know may have sent it before: the widest audience that *
   * reached. It is listed only when the audience now is surely wider than that.
   */
  before?: Audience;
}

export interface ColumnRemoved {
  name: string;
  from: string[];
  /** The widest audience over the queries that sent it. */
  audience: Audience;
  personal?: PersonalMatch;
  /**
   * When a * the schema does not know may still send it: the widest audience that * reaches.
   * It is listed only when that is surely narrower than before.
   */
  after?: Audience;
}

export interface TableDiff {
  table: string;
  status: "added" | "removed" | "changed";
  /** The widest audience over the table's queries (on-demand ones too: a client that subscribes gets them). */
  audience: AudienceChange;
  columns: {
    /**
     * Sent now and not before. A column is its device name and the table's columns its value
     * comes from, so '' AS email turned into email is one dropped and one added.
     */
    added: ColumnAdded[];
    /** Sent before and not now. */
    removed: ColumnRemoved[];
    /** Sent before and now, to a different audience (the widest over the queries that send it). */
    audience: { name: string; from: string[]; personal?: PersonalMatch; change: AudienceChange }[];
    /** Sent before and now, and marked or matched as personal differently (a comment marker added or removed, say). */
    personal: { name: string; from: string[]; before?: PersonalMatch; after?: PersonalMatch }[];
    /**
     * False on a side where some query's * reads a table the schema there does not know, or
     * knows only in part, or where a query that cannot be read may send the table. A column
     * they may send is then compared only where the result holds whatever they send.
     */
    known: { before: boolean; after: boolean };
  };
  queries: { added: QueryRef[]; removed: QueryRef[]; changed: QueryChange[] };
}

export type Unread = MapLike["unread"][number];

export interface ExposureDiff {
  /** Whether anything below is listed. */
  changed: boolean;
  /**
   * Whether something below surely reaches more users, or can no longer be shown not to: a
   * table newly sent (where nothing unreadable may have sent it before), a column newly sent,
   * a table, column or query whose audience is wider, a query that cannot be read and was not
   * unreadable before (a new one included), or a table whose columns could all be read before
   * and cannot now. Never true without such an entry.
   */
  widened: boolean;
  /** When one side is sync streams and the other sync rules. */
  kind?: { before: MapLike["kind"]; after: MapLike["kind"] };
  /** Tables with a change, sorted by name. */
  tables: TableDiff[];
  /** Queries that cannot be read, by stream and SQL: new ones, and ones gone or readable now. */
  unread: { added: Unread[]; removed: Unread[] };
}

/** Who receives what in `after` that differs from `before`. */
export function diffExposure(before: MapLike, after: MapLike): ExposureDiff {
  const unreadKey = (u: Unread) => key(u.stream, u.sql);
  const keys = { before: new Set(before.unread.map(unreadKey)), after: new Set(after.unread.map(unreadKey)) };
  const unreadDiff = { added: after.unread.filter((u) => !keys.before.has(unreadKey(u))), removed: before.unread.filter((u) => !keys.after.has(unreadKey(u))) };
  const hidden = { before: hiddenBy(before.unread), after: hiddenBy(after.unread) };
  const old = new Map(before.tables.map((t) => [t.table, t.queries]));
  const now = new Map(after.tables.map((t) => [t.table, t.queries]));
  const names = [...new Set([...old.keys(), ...now.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tables = names.map((name) => tableDiff(name, (old.get(name) ?? []).map(read), (now.get(name) ?? []).map(read), { before: hidden.before(name), after: hidden.after(name) })).filter((t): t is TableDiff => t !== undefined);

  const kind = before.kind === after.kind ? undefined : { before: before.kind, after: after.kind };
  const widened = unreadDiff.added.length > 0 || tables.some(widens);
  const changed = kind !== undefined || tables.length > 0 || unreadDiff.added.length > 0 || unreadDiff.removed.length > 0;
  return { changed, widened, ...(kind ? { kind } : {}), tables, unread: unreadDiff };
}

/**
 * Whether a side's unreadable queries may send a table: those whose table could be read send
 * only theirs, and one whose table could not be read may send any.
 */
function hiddenBy(unread: Unread[]): (table: string) => boolean {
  const tables = new Set(unread.map((u) => u.table));
  return (table) => tables.has(undefined) || tables.has(table);
}

/** Whether a table's entry holds something that surely reaches more users, or can no longer be shown not to. */
export function widens(t: TableDiff): boolean {
  return (
    (t.status === "added" && t.columns.known.before) ||
    t.audience.direction === "wider" ||
    t.columns.added.length > 0 ||
    t.columns.audience.some((c) => c.change.direction === "wider") ||
    t.queries.changed.some((q) => q.audience?.direction === "wider") ||
    (t.columns.known.before && !t.columns.known.after)
  );
}

/**
 * Whether `after` surely reaches more users than `before`, surely fewer, or neither for sure.
 * Every user for every row reaches more users than anything short of it, but a client's pick
 * (any client can ask for any row, so it may reach every user already) and every user for
 * some rows or all (which may be all). The rest cannot be ranked from the files alone: a
 * group, for one, need not hold the row's owner.
 */
export function compareAudience(before: Audience, after: Audience): Direction {
  const all = (x: Audience) => x.kind === "everyone" && !x.mixed;
  const maybeAll = (x: Audience) => x.kind === "client" || (x.kind === "everyone" && x.mixed === true);
  if (all(after) && !all(before) && !maybeAll(before)) return "wider";
  if (all(before) && !all(after) && !maybeAll(after)) return "narrower";
  return "changed";
}

/** Whether two audiences are the same, as the map names them. */
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

/** SQL as the tokenizer reads it: spacing, comments and the case of words do not count. SQL it cannot read is compared as written. */
function normal(sql: string): string {
  try {
    return render(tokenize(sql));
  } catch {
    return sql;
  }
}

const key = (stream: string, sql: string) => `${stream}\0${normal(sql)}`;

/** A query with what decides its rows read once: its stream and SQL, and the SQL deciding its groups. */
interface Read {
  q: ExposedQuery;
  key: string;
  sql: string;
  /** Undefined for a map printed before queries carried it. */
  decidedBy: Map<string, string> | undefined;
  /** Whether the columns it sends are all known. */
  known: boolean;
}

function read(q: ExposedQuery): Read {
  const decidedBy = q.decidedBy && new Map(q.decidedBy.map((d) => [d.name, normal(d.sql)]));
  return { q, key: key(q.stream, q.sql), sql: normal(q.sql), decidedBy, known: q.columns.source !== "unknown" && q.columns.complete };
}

/** `hidden`: whether an unreadable query on that side may send the table. */
function tableDiff(table: string, before: Read[], after: Read[], hidden: { before: boolean; after: boolean }): TableDiff | undefined {
  const pairs = matchQueries(before, after);
  const paired = new Set(pairs.flat());
  const addedReads = after.filter((r) => !paired.has(r));
  const removedReads = before.filter((r) => !paired.has(r));
  const changes = pairs.map(([b, a]) => queryChange(b, a));
  const queries = {
    added: addedReads.map(ref),
    removed: removedReads.map(ref),
    changed: changes.filter((q): q is QueryChange => q !== undefined),
  };

  const audience = tableAudience(before, after, {
    // Each query found on both sides sends what it did, to the same users.
    same: changes.every((c) => c === undefined || (!c.sql && !c.decidedBy && !c.audience)),
    added: addedReads,
    removed: removedReads,
    hidden,
  });
  const columns = columnsDiff(before, after, hidden);
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
 * The table's widest audience on each side. A side where an unreadable query may send the
 * table may hide any audience, so nothing is ranked wider when that is the side before, or
 * narrower when it is the side after.
 *
 * Its rows reach the union of its queries' audiences, so beyond what the two widest say: a
 * table that keeps every query it had, unchanged, and only adds queries, one of them to a role
 * check or a fixed filter none of the others had (which reach users whatever rows they own),
 * reaches everyone it did and more: wider. The mirror is narrower. An added owner or group is
 * not ranked: its users may be those who had the rows already.
 */
function tableAudience(before: Read[], after: Read[], m: { same: boolean; added: Read[]; removed: Read[]; hidden: { before: boolean; after: boolean } }): AudienceChange {
  const b = before.length ? widest(before.map((r) => r.q.audience)) : undefined;
  const a = after.length ? widest(after.map((r) => r.q.audience)) : undefined;
  if (!b || !a) return { ...(b ? { before: b } : {}), ...(a ? { after: a } : {}) };
  if (sameAudience(b, a)) return { before: b, after: a };
  let direction = compareAudience(b, a);
  if (direction === "changed" && m.same) {
    const fresh = (r: Read, others: Read[]) => (r.q.audience.kind === "role" || r.q.audience.kind === "fixed") && !others.some((o) => sameAudience(o.q.audience, r.q.audience));
    const unsure = (x: Audience) => x.kind === "client" || (x.kind === "everyone" && x.mixed === true);
    if (!m.removed.length && m.added.some((r) => fresh(r, before)) && !unsure(b)) direction = "wider";
    else if (!m.added.length && m.removed.some((r) => fresh(r, after)) && !unsure(a)) direction = "narrower";
  }
  if ((direction === "wider" && m.hidden.before) || (direction === "narrower" && m.hidden.after)) direction = "changed";
  return { before: b, after: a, direction };
}

/**
 * The queries found on both sides, in the after map's order: first those of the same stream
 * with the same SQL (a query that only moved, so its label changed); then, per stream, the one
 * query left on each side (edited in place). Labels are positions, which a query added,
 * dropped or moved changes, so two or more left in a stream are not paired: they are listed
 * as dropped and added.
 */
function matchQueries(before: Read[], after: Read[]): [Read, Read][] {
  const pairs = new Map<Read, Read>();
  const free = new Map<string, Read[]>();
  for (const b of before) {
    const list = free.get(b.key);
    if (list) list.push(b);
    else free.set(b.key, [b]);
  }
  for (const a of after) {
    const b = free.get(a.key)?.shift();
    if (b) pairs.set(a, b);
  }
  const taken = new Set(pairs.values());
  const left = new Map<string, Read[]>();
  const right = new Map<string, Read[]>();
  const add = (m: Map<string, Read[]>, r: Read) => {
    const list = m.get(r.q.stream);
    if (list) list.push(r);
    else m.set(r.q.stream, [r]);
  };
  for (const b of before) if (!taken.has(b)) add(left, b);
  for (const a of after) if (!pairs.has(a)) add(right, a);
  for (const [stream, rs] of right) {
    const ls = left.get(stream);
    if (rs.length === 1 && ls?.length === 1) pairs.set(rs[0] as Read, ls[0] as Read);
  }
  return after.filter((a) => pairs.has(a)).map((a) => [pairs.get(a) as Read, a]);
}

const ref = ({ q }: Read): QueryRef => ({ stream: q.stream, query: q.query, sql: q.sql, audience: q.audience, autoSubscribe: q.autoSubscribe });

function queryChange(b: Read, a: Read): QueryChange | undefined {
  const sql = b.sql === a.sql ? undefined : { before: b.q.sql, after: a.q.sql };
  const decided = b.decidedBy && a.decidedBy ? decidedChange(b, a) : [];
  const audience = sameAudience(b.q.audience, a.q.audience) ? undefined : { before: b.q.audience, after: a.q.audience, direction: compareAudience(b.q.audience, a.q.audience) };
  const autoSubscribe = b.q.autoSubscribe === a.q.autoSubscribe ? undefined : { before: b.q.autoSubscribe, after: a.q.autoSubscribe };
  let columns: QueryChange["columns"];
  if (b.known && a.known) {
    const ids = (r: Read) => r.q.columns.items.map((c) => [columnId(c.name, c.from), c.name] as const);
    const [was, is] = [ids(b), ids(a)];
    const [had, has] = [new Set(was.map(([id]) => id)), new Set(is.map(([id]) => id))];
    const added = is.filter(([id]) => !had.has(id)).map(([, name]) => name);
    const removed = was.filter(([id]) => !has.has(id)).map(([, name]) => name);
    if (added.length || removed.length) columns = { added, removed };
  }
  // A label alone that changed (a query inserted before it) sends nothing new.
  if (!sql && !decided.length && !audience && !autoSubscribe && !columns) return undefined;
  return {
    stream: a.q.stream,
    query: { before: b.q.query, after: a.q.query },
    ...(sql ? { sql } : {}),
    ...(decided.length ? { decidedBy: decided } : {}),
    ...(audience ? { audience } : {}),
    ...(autoSubscribe ? { autoSubscribe } : {}),
    ...(columns ? { columns } : {}),
  };
}

/**
 * The SQL deciding who a query's rows reach, compared by what it says: SQL on one side only is
 * dropped or added (by its name there), and one name holding other SQL on each side is edited.
 * Parameter queries are named by position, so one inserted before another is one added.
 */
function decidedChange(b: Read, a: Read): NonNullable<QueryChange["decidedBy"]> {
  const texts = (r: Read) => new Map((r.q.decidedBy ?? []).map((d) => [d.name, d.sql]));
  const [rawB, rawA] = [texts(b), texts(a)];
  const was = new Set(b.decidedBy?.values());
  const is = new Set(a.decidedBy?.values());
  const out = new Map<string, { name: string; before?: string; after?: string }>();
  for (const [name, sql] of b.decidedBy ?? []) if (!is.has(sql)) out.set(name, { name, before: rawB.get(name) as string });
  for (const [name, sql] of a.decidedBy ?? []) if (!was.has(sql)) out.set(name, { ...(out.get(name) ?? { name }), after: rawA.get(name) as string });
  return [...out.values()];
}

/** A column's identity: its device name and the table's columns its value comes from. */
const columnId = (name: string, from: string[]) => JSON.stringify([name, [...from].sort()]);

interface Column {
  name: string;
  from: string[];
  /** The audiences of the queries that list it (or a * the schema knows). */
  audiences: Audience[];
  /** The first personal match for it. */
  personal?: PersonalMatch;
}

/** A side's columns by identity, and the audiences of the queries whose * the schema does not know, which may send any column. */
function sentColumns(reads: Read[]): { columns: Map<string, Column>; star: Audience[] } {
  const columns = new Map<string, Column>();
  const star: Audience[] = [];
  for (const { q, known } of reads) {
    if (!known) star.push(q.audience);
    for (const c of q.columns.items) {
      const id = columnId(c.name, c.from);
      const column = columns.get(id);
      if (column) {
        column.audiences.push(q.audience);
        if (c.personal && !column.personal) column.personal = c.personal;
      } else columns.set(id, { name: c.name, from: c.from, audiences: [q.audience], ...(c.personal ? { personal: c.personal } : {}) });
    }
  }
  return { columns, star };
}

/**
 * Columns compared by identity. Where a side has a * the schema does not know, or a query that
 * cannot be read may send the table, a column may be sent there unseen, so the comparison takes
 * the widest it may reach on that side and the narrowest it surely reaches on the other, and
 * says only what holds either way.
 */
function columnsDiff(before: Read[], after: Read[], hidden: { before: boolean; after: boolean }): TableDiff["columns"] {
  const b = sentColumns(before);
  const a = sentColumns(after);
  // An unreadable query that may send the table may send any column, to anyone.
  if (hidden.before) b.star.push({ kind: "everyone" });
  if (hidden.after) a.star.push({ kind: "everyone" });
  const most = (list: Audience[]) => (list.length ? widest(list) : undefined);
  const named = (c: Column) => ({ name: c.name, from: c.from });
  const personalOf = (c: Column) => (c.personal ? { personal: c.personal } : {});

  const added: ColumnAdded[] = [];
  const audience: TableDiff["columns"]["audience"] = [];
  const personal: TableDiff["columns"]["personal"] = [];
  for (const [id, column] of a.columns) {
    const now = widest(column.audiences);
    const was = b.columns.get(id);
    if (!was) {
      const unseen = most(b.star);
      if (!unseen) added.push({ ...named(column), audience: now, ...personalOf(column) });
      else if (compareAudience(unseen, now) === "wider") added.push({ ...named(column), audience: now, ...personalOf(column), before: unseen });
      continue;
    }
    const then = widest(was.audiences);
    let change: AudienceChange | undefined;
    if (!b.star.length && !a.star.length) {
      if (!sameAudience(then, now)) change = { before: then, after: now, direction: compareAudience(then, now) };
    } else {
      const thenAtMost = most([...was.audiences, ...b.star]) as Audience;
      const nowAtMost = most([...column.audiences, ...a.star]) as Audience;
      if (compareAudience(thenAtMost, now) === "wider") change = { before: thenAtMost, after: now, direction: "wider" };
      else if (compareAudience(then, nowAtMost) === "narrower") change = { before: then, after: nowAtMost, direction: "narrower" };
    }
    if (change) audience.push({ ...named(column), ...personalOf(column), change });
    if (!samePersonal(was.personal, column.personal)) personal.push({ ...named(column), ...(was.personal ? { before: was.personal } : {}), ...(column.personal ? { after: column.personal } : {}) });
  }

  const removed: ColumnRemoved[] = [];
  for (const [id, column] of b.columns) {
    if (a.columns.has(id)) continue;
    const then = widest(column.audiences);
    const unseen = most(a.star);
    if (!unseen) removed.push({ ...named(column), audience: then, ...personalOf(column) });
    else if (compareAudience(then, unseen) === "narrower") removed.push({ ...named(column), audience: then, ...personalOf(column), after: unseen });
  }
  return { added, removed, audience, personal, known: { before: !b.star.length, after: !a.star.length } };
}

const samePersonal = (x: PersonalMatch | undefined, y: PersonalMatch | undefined) =>
  x === undefined || y === undefined ? x === y : x.category === y.category && x.matched === y.matched && x.source === y.source;
