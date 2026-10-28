/**
 * `samesight lint --format github`: GitHub Actions workflow commands, one per finding, which
 * GitHub shows as annotations on the run and on the pull request's changed lines, with no
 * code scanning needed.
 */

import { type LintLevel, type LintRun, repoPath, sortFindings } from "./finding.ts";

const COMMAND: Record<LintLevel, string> = { error: "error", warning: "warning", info: "notice" };

/** A command's message: %, CR and LF escaped, so it stays one line. */
export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** A command's property value: escaped as a message, and : and , too. */
export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function command(name: string, properties: Record<string, string | number | undefined>, message: string): string {
  const props = Object.entries(properties)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${escapeProperty(String(v))}`)
    .join(",");
  return `::${name}${props ? ` ${props}` : ""}::${escapeData(message)}`;
}

/** One command per kept finding and per unreadable file, then a notice of what --allow accepted. */
export function formatGithub(run: LintRun): string {
  const lines = sortFindings(run.kept).map((f) =>
    command(COMMAND[f.level], { file: repoPath(f.file), line: f.line, col: f.line ? f.column : undefined, title: `samesight ${f.rule}` }, f.message),
  );
  for (const u of run.unreadable) lines.push(command("error", { file: repoPath(u.file) }, `could not read: ${u.error}`));
  const n = run.allowed.length;
  if (n) lines.push(command("notice", {}, `${n} finding${n === 1 ? "" : "s"} allowed by --allow`));
  return lines.join("\n");
}
