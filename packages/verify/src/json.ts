/**
 * The `--json` document: one per run, on stdout, for exits 0, 1 and 2. Its shape is
 * schema/report.schema.json; each field is picked by name, so nothing else a finding
 * carries reaches it.
 */

import { parseArgs } from "node:util";
import { readSeed } from "./replay.ts";
import type { Finding, RowReport } from "./report.ts";

export interface Section {
  title: string;
  findings: Finding[];
}

export interface ReportDocument {
  $schema: string;
  version: 1;
  tool: "samesight-verify";
  toolVersion: string;
  mode: "policy" | "audit";
  result: "passed" | "failed" | "incomplete";
  exitCode: 0 | 1 | 2;
  durationMs: number;
  seed?: number;
  replay?: string;
  sections: Section[];
  error?: string;
}

/** Where a version's schema is published: the file the package ships, on the npm CDN. */
export const schemaUrl = (version: string) => `https://unpkg.com/@samesight/verify@${version}/schema/report.schema.json`;

const RESULT = { 0: "passed", 1: "failed", 2: "incomplete" } as const;

/** The run's arguments as the mode, and the --seed when it is one a run would take. */
export function runOf(argv: string[]): { mode: ReportDocument["mode"]; seed?: number } {
  const mode = argv[0] === "audit" ? "audit" : "policy";
  // Read loosely: the document is written for a run whose flags failed too.
  const { values } = parseArgs({ args: argv, options: { seed: { type: "string" } }, strict: false, allowPositionals: true });
  const seed = typeof values.seed === "string" ? readSeed(values.seed) : undefined;
  return seed !== undefined ? { mode, seed } : { mode };
}

export function reportDocument(o: {
  toolVersion: string;
  argv: string[];
  exitCode: number;
  durationMs: number;
  sections: Section[];
  error?: string;
}): ReportDocument {
  const exitCode = o.exitCode === 0 || o.exitCode === 1 ? o.exitCode : 2;
  const { mode, seed } = runOf(o.argv);
  const replay = o.sections.flatMap((s) => s.findings).find((f) => f.replay)?.replay;
  return {
    $schema: schemaUrl(o.toolVersion),
    version: 1,
    tool: "samesight-verify",
    toolVersion: o.toolVersion,
    mode,
    result: RESULT[exitCode],
    exitCode,
    durationMs: Math.max(0, Math.round(o.durationMs)),
    ...(seed !== undefined ? { seed } : {}),
    ...(replay !== undefined ? { replay } : {}),
    sections: o.sections.map((s) => ({ title: s.title, findings: s.findings.map(finding) })),
    ...(o.error !== undefined ? { error: o.error } : {}),
  };
}

/** Keeps the fields named, in that order, leaving out those that are not set. */
function pick<T extends object, K extends keyof T>(x: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (x[k] !== undefined) out[k] = x[k];
  return out;
}

function finding(f: Finding): Finding {
  return { ...pick(f, ["status", "check", "detail", "incomplete"]), ...(f.rows ? { rows: f.rows.map(row) } : {}), ...pick(f, ["replay"]) };
}

function row(r: RowReport): RowReport {
  return {
    ...pick(r, ["kind", "summary"]),
    user: pick(r.user, ["label", "id", "role"]),
    ...pick(r, ["table", "id", "row", "columns"]),
    sentBy: r.sentBy.map((s) => pick(s, ["stream", "query", "sql"])),
    ...(r.policies ? { policies: r.policies.map((p) => pick(p, ["name", "permissive", "verdict"])) } : {}),
    ...pick(r, ["policiesNote"]),
    ...(r.fix ? { fix: pick(r.fix, ["query", "add", "why"]) } : {}),
  };
}
