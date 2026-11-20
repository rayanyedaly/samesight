/**
 * Exposure: which columns that likely hold personal data, by their name or a samesight
 * comment marker, of one run user's rows reached another run user's device, and through
 * which stream, over the datasets the differential ran before its first failure.
 *
 * Informational: whether a user may have a row at all is the comparison's question; this
 * says which of its columns came with it. A row belongs to the run user its table's column
 * for a user holds (a key to auth.users, as the generator fills it). Ownership through a
 * parent row is not read, and neither are rows the run did not insert.
 */

import { type PersonalMatch, personalColumn } from "samesight/compiler";
import type { DeviceRow } from "../differential/device.ts";
import type { TableModel } from "../differential/model.ts";
import type { Run } from "../differential/run.ts";
import type { Finding } from "../report.ts";
import { userColumn } from "./fixed.ts";

/** A synced table with likely personal columns and a column for its user. */
export interface ExposedTable {
  table: string;
  /** The column that holds the user a row belongs to. */
  owner: string;
  /** Each likely personal column, with what matched. */
  columns: Map<string, PersonalMatch>;
}

/** What one run user's device held of other run users' rows of a table, from one stream. */
export interface Held {
  reader: string;
  table: string;
  stream: string;
  columns: Set<string>;
  /** The run users whose rows they were. */
  owners: Set<string>;
  rows: number;
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
    const owner = userColumn(t);
    // The user's own id is no one else's personal data on their own row.
    if (owner) columns.delete(owner);
    if (!columns.size) continue;
    if (owner) tables.push({ table: t.name, owner, columns });
    else unowned.push({ table: t.name, columns: [...columns.keys()] });
  }
  return { tables, unowned, datasets: 0, held: new Map() };
}

/** Adds one passing dataset: each likely personal value a device holds of another run user's row, by stream. */
export function noteExposure(s: Pick<Run, "fixed">, ex: Exposure, devices: Map<string, DeviceRow[]>): void {
  ex.datasets++;
  const label = new Map(s.fixed.users.map((u) => [u.id, u.label.split(" ")[0] as string]));
  for (const u of s.fixed.users) {
    const reader = label.get(u.id) as string;
    for (const r of devices.get(u.id) ?? []) {
      const t = ex.tables.find((x) => x.table === r.table);
      const owner = t ? r.data[t.owner] : undefined;
      if (!t || typeof owner !== "string" || owner === u.id || !label.has(owner)) continue;
      for (const source of r.sources) {
        const present = source.columns.filter((c) => t.columns.has(c) && r.data[c] !== null && r.data[c] !== undefined);
        if (!present.length) continue;
        const key = `${reader}\0${t.table}\0${source.stream}`;
        const held = ex.held.get(key) ?? { reader, table: t.table, stream: source.stream, columns: new Set<string>(), owners: new Set<string>(), rows: 0 };
        for (const c of present) held.columns.add(c);
        held.owners.add(owner);
        held.rows++;
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
  const held = [...ex.held.values()].sort((a, b) => a.reader.localeCompare(b.reader) || a.table.localeCompare(b.table) || a.stream.localeCompare(b.stream));
  for (const h of held) {
    const t = ex.tables.find((x) => x.table === h.table) as ExposedTable;
    const columns = [...t.columns].filter(([c]) => h.columns.has(c)).map(([c, m]) => named(c, m));
    const others = plural(h.owners.size, "other run user's", "other run users'");
    out.push({
      status: "ok",
      check,
      detail: `${h.reader}'s device held ${columns.join(", ")} of ${others} ${h.table} rows, sent by stream ${h.stream} (${plural(h.rows, "row")} over ${plural(ex.datasets, "dataset")})`,
    });
  }
  if (!held.length) {
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
  return cut ? `Exposure in the ${ex.datasets} datasets run${cut}` : "Exposure (columns that likely hold personal data, by name or comment marker, of other run users' rows)";
}
