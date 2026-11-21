/**
 * The `lint --format json` document: one per run, on stdout, for exits 0, 1 and 2. Its shape
 * is schema/lint.schema.json; each field is picked by name, so nothing else a finding carries
 * reaches it.
 */

import { type LintFinding, sortFindings, type Unreadable } from "./finding.ts";
import type { LintRun } from "./run.ts";

export interface LintDocument {
  $schema: string;
  version: 1;
  tool: "samesight";
  toolVersion: string;
  files: string[];
  rlsChecked: boolean;
  findings: LintFinding[];
  allowed: LintFinding[];
  unreadable: Unreadable[];
  errors: number;
  warnings: number;
  notes: number;
  exitCode: 0 | 1 | 2;
  error?: string;
}

/** Where a version's schema is published: the file the package ships, on the npm CDN. */
export const lintSchemaUrl = (version: string) => `https://unpkg.com/samesight@${version}/schema/lint.schema.json`;

function finding(f: LintFinding): LintFinding {
  return {
    rule: f.rule,
    level: f.level,
    file: f.file,
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.column !== undefined ? { column: f.column } : {}),
    message: f.message,
    ...(f.subjects ? { subjects: [...f.subjects] } : {}),
  };
}

/** The document for a run, or, given an error instead, for a run that could not start. */
export function lintDocument(toolVersion: string, run: Omit<LintRun, "messages"> | { error: string }): LintDocument {
  const head = { $schema: lintSchemaUrl(toolVersion), version: 1 as const, tool: "samesight" as const, toolVersion };
  if ("error" in run) return { ...head, files: [], rlsChecked: false, findings: [], allowed: [], unreadable: [], errors: 0, warnings: 0, notes: 0, exitCode: 2, error: run.error };
  const count = (level: LintFinding["level"]) => run.kept.filter((f) => f.level === level).length;
  return {
    ...head,
    files: [...run.files],
    rlsChecked: run.rlsChecked,
    findings: sortFindings(run.kept).map(finding),
    allowed: sortFindings(run.allowed).map(finding),
    unreadable: run.unreadable.map((u) => ({ file: u.file, error: u.error })),
    errors: count("error"),
    warnings: count("warning"),
    notes: count("info"),
    exitCode: run.code,
  };
}
