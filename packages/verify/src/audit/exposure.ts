/**
 * Exposure: which columns that likely hold personal data, by their name or a samesight
 * comment marker, of one run user's rows reached another run user's device, and through
 * which stream, over the datasets the differential ran before its first failure.
 *
 * Informational: whether a user may have a row at all is the comparison's question; this
 * says which of its columns came with it. A row belongs to the run users its columns for a
 * user hold (each key to auth.users, as the run inserted it), so a stream that leaves those
 * columns out still counts. Ownership through a parent row is not read, and neither are rows
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
  table: string;
  stream: string;
  columns: Set<string>;
  /** The run users whose rows they were. */
  owners: Set<string>;
  /** The rows, by id: a row the run keeps for every dataset counts once. */
  rows: Set<string>;
}

export interface Exposure {
  tables: ExposedTable[];
  /** Synced tables with likely personal columns but no column for a user: not measured. */
  unowned: { table: string; columns: string[] }[];
  datasets: number;
  held: Map<string, Held>;
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
    if (owners.length) tables.push({ table: t.name, owners, columns });
    else unowned.push({ table: t.name, columns: [...columns.keys()] });
  }
  return { tables, unowned, datasets: 0, held: new Map() };
}

/**
 * Adds one passing dataset: each likely personal value a device holds of another run user's
 * row, by stream. `inserted`: the run's rows, the dataset's and those it keeps for every
 * dataset, which say whose each row is.
 */
export function noteExposure(s: Pick<Run, "fixed">, ex: Exposure, inserted: Inserted[], devices: Map<string, DeviceRow[]>): void {
  ex.datasets++;
  const label = new Map(s.fixed.users.map((u) => [u.id, u.label.split(" ")[0] as string]));
  // Whose each run row is, by table and id: the run users its columns for a user hold.
  const owners = new Map<string, string[]>();
  for (const i of inserted) {
    const t = ex.tables.find((x) => x.table === i.table);
    if (!t) continue;
    const users = t.owners.map((c) => i.row[c]).filter((v): v is string => typeof v === "string" && label.has(v));
    if (users.length) owners.set(`${i.table}\0${String(i.row.id)}`, users);
  }
  for (const [order, u] of s.fixed.users.entries()) {
    const reader = label.get(u.id) as string;
    for (const r of devices.get(u.id) ?? []) {
      const t = ex.tables.find((x) => x.table === r.table);
      const users = t ? owners.get(`${r.table}\0${r.id}`) : undefined;
      // A row that is in part the reader's own (sent to them, say) is theirs to hold.
      if (!t || !users || users.includes(u.id)) continue;
      for (const source of r.sources) {
        const present = source.columns.filter((c) => t.columns.has(c) && r.data[c] !== null && r.data[c] !== undefined);
        if (!present.length) continue;
        const key = `${reader}\0${t.table}\0${source.stream}`;
        const held = ex.held.get(key) ?? { reader, order, table: t.table, stream: source.stream, columns: new Set<string>(), owners: new Set<string>(), rows: new Set<string>() };
        for (const c of present) held.columns.add(c);
        for (const o of users) held.owners.add(o);
        held.rows.add(r.id);
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
  const held = [...ex.held.values()].sort((a, b) => a.order - b.order || a.table.localeCompare(b.table) || a.stream.localeCompare(b.stream));
  for (const h of held) {
    const t = ex.tables.find((x) => x.table === h.table) as ExposedTable;
    const columns = [...t.columns].filter(([c]) => h.columns.has(c)).map(([c, m]) => named(c, m));
    const others = plural(h.owners.size, "other run user's", "other run users'");
    out.push({
      status: "ok",
      check,
      detail: `${h.reader}'s device held ${columns.join(", ")} of ${others} ${h.table} rows, sent by stream ${h.stream} (${plural(h.rows.size, "row")} over ${plural(ex.datasets, "dataset")})`,
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
          ? "no synced table with a likely personal column has a column for its user, so none was measured"
          : "no synced table has a column that looks personal, by its name or a comment marker",
    });
  }
  for (const u of ex.unowned) {
    out.push({ status: "ok", check, detail: `${u.table}: ${u.columns.join(", ")} likely personal, but no column of it references auth.users, so whose rows reach whom is not read here` });
  }
  return out;
}

/** The section's title, and how much it covers when a failure or the time limit cut the run short. */
export function exposureTitle(ex: Exposure, result: { findings: Finding[]; stopped?: boolean }): string {
  const cut = result.findings.some((f) => f.status === "fail") ? " before the failure" : result.stopped ? " before the time limit" : "";
  return cut ? `Exposure in the ${plural(ex.datasets, "dataset")} run${cut}` : "Exposure (columns that likely hold personal data, by name or comment marker, of other run users' rows)";
}
