/**
 * The core promise, per user: every row on the device is a row RLS returns, with no
 * column the policy hides from that role; and every row RLS returns is on the device,
 * with the same values in every column the role is not denied.
 */

import type { DeviceRow } from "./device.ts";
import type { TableModel } from "./model.ts";
import { type RlsRows, rowKey } from "./rls.ts";

export type ProblemKind = "leak" | "hidden" | "gap" | "differs";

export interface Problem {
  kind: ProblemKind;
  table: string;
  id: string;
  /** The streams that sent the row (leaks and hidden columns). */
  streams: string[];
  /** The row as RLS or the device has it, for the report. */
  row: Record<string, unknown>;
  /** A hidden column, or the columns that differ. */
  columns?: string[];
}

const TIMESTAMP = /^(timestamp|date|time)/;

/** One value as both sides can agree on it: PowerSync sends JSON text, RLS row_to_json. */
export function normalize(type: string | undefined, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (type && TIMESTAMP.test(type) && typeof v === "string") {
    const ms = Date.parse(v.replace(" ", "T"));
    return Number.isNaN(ms) ? v : ms;
  }
  if (type === "boolean") return v === true || v === 1 || v === "true" || v === "t";
  if (type === "jsonb" || type === "json") return JSON.stringify(typeof v === "string" ? JSON.parse(v) : v);
  if (typeof v === "number" || typeof v === "bigint") return Number(v);
  if (type && /^(bigint|integer|smallint|numeric|real|double)/.test(type) && typeof v === "string") return Number(v);
  return v;
}

export function compare(device: DeviceRow[], rls: RlsRows, hidden: Map<string, string[]>, model: TableModel[]): Problem[] {
  const problems: Problem[] = [];
  const types = new Map(model.map((t) => [t.name, new Map(t.columns.map((c) => [c.name, c.type]))]));
  const onDevice = new Set<string>();
  for (const d of device) {
    const key = rowKey(d.table, d.id);
    onDevice.add(key);
    const allowed = rls.get(key);
    if (!allowed) {
      problems.push({ kind: "leak", table: d.table, id: d.id, streams: d.sources.map((s) => s.stream), row: d.data });
      continue;
    }
    for (const column of hidden.get(d.table) ?? []) {
      const streams = d.sources.filter((s) => s.columns.includes(column)).map((s) => s.stream);
      if (streams.length) problems.push({ kind: "hidden", table: d.table, id: d.id, streams, row: d.data, columns: [column] });
    }
    const colTypes = types.get(d.table);
    const differs = Object.keys(allowed).filter(
      (c) => !(hidden.get(d.table) ?? []).includes(c) && JSON.stringify(normalize(colTypes?.get(c), allowed[c])) !== JSON.stringify(normalize(colTypes?.get(c), d.data[c])),
    );
    if (differs.length) problems.push({ kind: "differs", table: d.table, id: d.id, streams: d.sources.map((s) => s.stream), row: allowed, columns: differs });
  }
  for (const [key, row] of rls) {
    if (onDevice.has(key)) continue;
    const [table = "", id = ""] = key.split("\u0000");
    problems.push({ kind: "gap", table, id, streams: [], row });
  }
  return problems;
}
