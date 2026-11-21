/**
 * Exposure: which columns that likely hold personal data, by their name or a samesight
 * comment marker, of one run user's rows reached another run user's device, and through
 * which stream, over the datasets the differential ran before its first failure.
 *
 * Informational: whether a user may have a row at all is the comparison's question; this
 * says which of its columns came with it. A row belongs to the run users its columns for a
 * user hold (each key to auth.users, as the run inserted it), so a stream that leaves those
 * columns out still counts. A row the reader is one of the users of (a doctor's visit with a
 * patient) is counted apart, as shared: its values may be the reader's own. Ownership through a parent row is not read, and neither are rows
 * the run did not insert. Datasets that pass hold the columns under their own names: a
 * renamed or computed column fails the comparison first.
 */

import { type PersonalMatch, personalColumn } from "samesight/compiler";
import type { DeviceRow } from "../differential/device.ts";
import type { TableModel } from "../differential/model.ts";
import type { Run } from "../differential/run.ts";
import type { Inserted } from "../differential/world.ts";
import type { Finding } from "../report.ts";

/** A synced table with likely personal columns and a column for its user. */
export interface ExposedTable {
  table: string;
  /** The columns that hold a user the row belongs to: every key to auth.users. */
  owners: string[];
  /** Each likely personal column, with what matched. */
  columns: Map<string, PersonalMatch>;
}

/** What one run user's device held of other run users' rows of a table, from one stream. */
export interface Held {
  reader: string;
  /** The reader's place among the run's users, for the order lines are printed in. */
  order: number;
  /** Rows the reader is one of the users of, kept apart: their values may be the reader's own. */
  shared: boolean;
  table: string;
  stream: string;
  columns: Set<string>;
  /** The run users whose rows they were. */
  owners: Set<string>;
  /** The rows: a row the run keeps for every dataset counts once, a dataset's own row once per dataset. */
  rows: Set<string>;
}

export interface Exposure {
  tables: ExposedTable[];
  /** Synced tables with likely personal columns whose rows cannot be told apart by user: not measured, and why. */
  unowned: { table: string; columns: string[]; why: string }[];
  datasets: number;
  held: Map<string, Held>;
  /** Tables some of whose run rows took their id from the database, so those rows were not matched. */
  unmatched: Set<string>;
}

/** The synced tables to watch, from the model: their likely personal columns and their user's column. */
export function exposureScope(model: TableModel[], synced: string[]): Exposure {
  const tables: ExposedTable[] = [];
  const unowned: Exposure["unowned"] = [];
  for (const t of model.filter((m) => synced.includes(m.name))) {
    const siblings = t.columns.map((c) => c.name);
    const columns = new Map<string, PersonalMatch>();
    for (const c of t.columns) {
      const match = personalColumn(c.name, t.name, { type: c.type, siblings, ...(c.comment ? { comment: c.comment } : {}) });
      if (match) columns.set(c.name, match);
    }
    if (!columns.size) continue;
    const owners = t.foreignKeys.filter((fk) => fk.schema === "auth" && fk.table === "users" && fk.columns.length === 1).map((fk) => fk.columns[0] as string);
    // A user's id names whose row it is; it is no one else's personal data on it.
    for (const o of owners) columns.delete(o);
    if (!columns.size) continue;
    // Rows are matched to the run's by id: a sequence's id is not read back, so its rows would never match.
    const id = t.columns.find((c) => c.name === "id");
    const why = !owners.length ? "no column of it references auth.users" : !id ? "it has no id column to match its rows by" : id.autoKey || id.computed ? "the database sets its id, which the run does not read back" : undefined;
    if (why) unowned.push({ table: t.name, columns: [...columns.keys()], why });
    else tables.push({ table: t.name, owners, columns });
  }
  return { tables, unowned, datasets: 0, held: new Map(), unmatched: new Set() };
}

/**
 * Adds one passing dataset: each likely personal value a device holds of another run user's
 * row, by stream. `inserted`: the dataset's own rows; the rows the run keeps for every dataset
 * come from `s.fixedRows`. Together they say whose each row is.
 */
export function noteExposure(s: Pick<Run, "fixed" | "fixedRows">, ex: Exposure, inserted: Inserted[], devices: Map<string, DeviceRow[]>): void {
  ex.datasets++;
  const label = new Map(s.fixed.users.map((u) => [u.id, u.label.split(" ")[0] as string]));
  // Whose each run row is, by table and id: the run users its columns for a user hold. A row
  // kept for every dataset is one row however many hold it; a dataset's row is that dataset's
  // own, even when it takes an id the next dataset takes again (a key a claim holds).
  const owners = new Map<string, { users: string[]; row: string }>();
  const rows = [...(s.fixedRows ?? []).map((i) => ({ i, kept: true })), ...inserted.map((i) => ({ i, kept: false }))];
  for (const { i, kept } of rows) {
    const t = ex.tables.find((x) => x.table === i.table);
    if (!t) continue;
    // Left to a default, the id is the database's, and the row cannot be found again by it.
    if (i.row.id === undefined || i.row.id === null) {
      ex.unmatched.add(t.table);
      continue;
    }
    const users = t.owners.map((c) => i.row[c]).filter((v): v is string => typeof v === "string" && label.has(v));
    const id = String(i.row.id);
    if (users.length) owners.set(`${i.table}\0${id}`, { users, row: kept ? id : `${ex.datasets}\0${id}` });
  }
  for (const [order, u] of s.fixed.users.entries()) {
    const reader = label.get(u.id) as string;
    for (const r of devices.get(u.id) ?? []) {
      const t = ex.tables.find((x) => x.table === r.table);
      const owned = t ? owners.get(`${r.table}\0${r.id}`) : undefined;
      // The other run users whose row it is; when the reader is one too, the row is shared.
      const users = owned?.users.filter((o) => o !== u.id);
      if (!t || !owned || !users?.length) continue;
      const shared = users.length < owned.users.length;
      for (const source of r.sources) {
        const present = source.columns.filter((c) => t.columns.has(c) && r.data[c] !== null && r.data[c] !== undefined);
        if (!present.length) continue;
        const key = `${reader}\0${t.table}\0${source.stream}\0${shared}`;
        const held = ex.held.get(key) ?? { reader, order, shared, table: t.table, stream: source.stream, columns: new Set<string>(), owners: new Set<string>(), rows: new Set<string>() };
        for (const c of present) held.columns.add(c);
        for (const o of users) held.owners.add(o);
        held.rows.add(owned.row);
        ex.held.set(key, held);
      }
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A column as a line names it: its name and category, and whether its comment marks it. */
const named = (column: string, match: PersonalMatch) => `${column} [${match.category}${match.source === "comment" ? ", marked in its comment" : ""}]`;

/** The Exposure section: what each device held, by reader, table and stream; then the tables not measured. All ok. */
export function exposureFindings(ex: Exposure): Finding[] {
  const check = "exposure";
  const out: Finding[] = [];
  const held = [...ex.held.values()].sort((a, b) => a.order - b.order || a.table.localeCompare(b.table) || a.stream.localeCompare(b.stream) || Number(a.shared) - Number(b.shared));
  for (const h of held) {
    const t = ex.tables.find((x) => x.table === h.table) as ExposedTable;
    const columns = [...t.columns].filter(([c]) => h.columns.has(c)).map(([c, m]) => named(c, m));
    const whose = h.shared ? `${h.table} rows ${h.reader} shares with ${plural(h.owners.size, "other run user")}` : `${plural(h.owners.size, "other run user's", "other run users'")} ${h.table} rows`;
    out.push({
      status: "ok",
      check,
      detail: `${h.reader}'s device held ${columns.join(", ")} of ${whose}, sent by stream ${h.stream} (${plural(h.rows.size, "row")} over ${plural(ex.datasets, "dataset")})`,
    });
  }
  if (!held.length && ex.tables.length && !ex.datasets) {
    out.push({ status: "ok", check, detail: "no dataset passed before the run stopped, so nothing was measured" });
  } else if (!held.length) {
    out.push({
      status: "ok",
      check,
      detail: ex.tables.length
        ? "no likely personal column of one run user's rows reached another run user's device"
        : ex.unowned.length
          ? "no synced table with a likely personal column could be measured"
          : "no synced table has a column that looks personal, by its name or a comment marker",
    });
  }
  for (const table of [...ex.unmatched].sort()) {
    out.push({ status: "ok", check, detail: `${table}: some run rows took their id from the database, so those were not matched and are not counted here` });
  }
  for (const u of ex.unowned) {
    out.push({ status: "ok", check, detail: `${u.table}: ${u.columns.join(", ")} likely personal, but ${u.why}, so whose rows reach whom is not read here` });
  }
  return out;
}

/** The section's title, and how much it covers when a failure or the time limit cut the run short. */
export function exposureTitle(ex: Exposure, result: { findings: Finding[]; stopped?: boolean }): string {
  const cut = result.findings.some((f) => f.status === "fail") ? " before the failure" : result.stopped ? " before the time limit" : "";
  return cut ? `Exposure in the ${plural(ex.datasets, "dataset")} run${cut}` : "Exposure (columns that likely hold personal data, by name or comment marker, of other run users' rows)";
}
