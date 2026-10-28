/**
 * What lint reports: one finding per problem, named by its rule, at a line of a file. Lint
 * reads files only, so it proves nothing about what reaches a device; the audit does.
 */

export type LintLevel = "error" | "warning" | "info";

export interface LintFinding {
  /** The rule's name, as --allow takes it (e.g. "unscoped-query"). */
  rule: string;
  level: LintLevel;
  /** As the user named it, relative paths kept relative. */
  file: string;
  /** 1-based; absent when the finding is about the file as a whole. */
  line?: number;
  /** 1-based, where the query starts on `line`; absent when line is. */
  column?: number;
  message: string;
  /** Names --allow <rule>:<name> matches: the stream or bucket, the tables, the policy. */
  subjects?: string[];
}

const ORDER: Record<LintLevel, number> = { error: 0, warning: 1, info: 2 };

/** Sorted by file, then line (file-wide findings first), then level. */
export function sortFindings(findings: LintFinding[]): LintFinding[] {
  return [...findings].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.line ?? 0) - (b.line ?? 0) || ORDER[a.level] - ORDER[b.level],
  );
}

/** One line per finding, `file:line  level  message  (rule)`, then a summary line. */
export function formatLint(findings: LintFinding[]): string {
  const lines = sortFindings(findings).map((f) => `${f.file}${f.line ? `:${f.line}` : ""}  ${f.level.padEnd(7)}  ${f.message}  (${f.rule})`);
  return [...lines, summary(findings)].join("\n");
}

/** "2 errors, 1 warning", or "No problems found." */
export function summary(findings: LintFinding[]): string {
  const count = (level: LintLevel) => findings.filter((f) => f.level === level).length;
  const parts = [
    [count("error"), "error"],
    [count("warning"), "warning"],
    [count("info"), "note"],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "No problems found.";
}

/** 1 when any finding is an error; warnings and notes do not fail a run. */
export function exitCode(findings: LintFinding[]): 0 | 1 {
  return findings.some((f) => f.level === "error") ? 1 : 0;
}

/**
 * Splits findings by --allow entries: `<rule>` allows all of a rule's findings,
 * `<rule>:<name>` those whose subjects include the name (a stream, bucket, table or
 * policy; matched as written, so a quoted table keeps its case).
 */
export function applyAllow(findings: LintFinding[], allow: string[]): { kept: LintFinding[]; allowed: LintFinding[] } {
  const entries = allow.map((a) => {
    const at = a.indexOf(":");
    return at === -1 ? { rule: a, name: undefined } : { rule: a.slice(0, at), name: a.slice(at + 1) };
  });
  const allowed = (f: LintFinding) => entries.some((e) => e.rule === f.rule && (e.name === undefined || (f.subjects ?? []).includes(e.name)));
  return { kept: findings.filter((f) => !allowed(f)), allowed: findings.filter(allowed) };
}
