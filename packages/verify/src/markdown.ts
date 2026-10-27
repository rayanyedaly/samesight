/**
 * `--report`: a run's findings as Markdown, to paste into an issue. Each section is a list
 * of findings; each row a finding is about gets a heading, a table (who, which row, what
 * sent it, which policies decided, the likely fix), its queries' SQL and the replay command.
 */

import { decidingPolicies, type Finding, formatRow, type RowReport, rowSentence } from "./report.ts";

export interface MarkdownReport {
  mode: "policy" | "audit";
  exitCode: number;
  /** The sections as the run printed them, in order. */
  sections: { title: string; findings: Finding[] }[];
  /** Why the run could not go on (exit 2). */
  error?: string;
}

const MARK = { ok: "ok", warn: "**warn**", fail: "**FAIL**" } as const;

/** Text with every character Markdown could read as markup escaped, on one line. */
export function inline(s: string): string {
  return s
    .replace(/\s*\n\s*/g, " ")
    .replace(/[\\`*_[\]<>|~&#]/g, "\\$&");
}

/** A code span for a table cell: a backtick run longer than any inside, and `|` escaped as GFM tables need. */
export function code(s: string): string {
  const text = s.replace(/\s*\n\s*/g, " ");
  const ticks = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`.replace(/\|/g, "\\|");
}

/** A fenced block that no line of `text` can close early. */
export function fence(text: string, lang = ""): string[] {
  const ticks = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return [`${ticks}${lang}`, ...text.split("\n"), ticks];
}

/** Lines without the indent they all share. */
function dedent(lines: string[]): string {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return lines.map((l) => l.slice(indent)).join("\n");
}

function rowBlock(r: RowReport): string[] {
  const cells: [string, string][] = [
    ["User", `${inline(r.user.label)}, id ${code(r.user.id)}`],
    ["Row", inline(r.row)],
  ];
  if (r.columns?.length) cells.push(["Columns", r.columns.map(code).join(", ")]);
  if (r.sentBy.length) cells.push(["Sent by", r.sentBy.map((x) => `stream ${code(x.stream)}${x.query ? `, ${code(x.query)}` : ""}`).join("<br>")]);
  const decided = decidingPolicies(r);
  if (decided.length) {
    const by = r.kind === "gap" ? "Allowed by" : "Refused by";
    cells.push([by, decided.map((p) => `${p.permissive ? "" : "restrictive "}policy ${code(p.name)} on ${code(r.table)}`).join("<br>")]);
  }
  if (r.policiesNote) cells.push(["Policies", inline(r.policiesNote)]);
  if (r.fix) cells.push(["Likely fix", `${inline(r.fix.why)}; add ${code(r.fix.add)}`]);
  const sql = r.sentBy.filter((x) => x.sql).flatMap((x) => ["", `Stream ${inline(x.stream)}${x.query ? `, ${inline(x.query)}` : ""}:`, "", ...fence((x.sql ?? "").trim(), "sql")]);
  return [`### ${r.kind}: ${inline(rowSentence(r))}`, "", "| | |", "| --- | --- |", ...cells.map(([k, v]) => `| ${k} | ${v} |`), ...sql];
}

/**
 * The report: a title with the result and mode, the counts and exit code, the error that
 * stopped the run if one did, then each section's findings, with a block per row.
 */
export function toMarkdown(r: MarkdownReport): string {
  const all = r.sections.flatMap((s) => s.findings);
  const fails = all.filter((f) => f.status === "fail" && !f.incomplete).length;
  const incomplete = all.filter((f) => f.status === "fail" && f.incomplete).length;
  const warns = all.filter((f) => f.status === "warn").length;
  const result = r.error !== undefined ? "COULD NOT RUN" : r.exitCode === 0 ? "PASSED" : r.exitCode === 1 ? "FAILED" : "INCOMPLETE";
  const counts = [
    ...(fails ? [`${fails} failing`] : []),
    ...(incomplete ? [`${incomplete} could not run`] : []),
    ...(warns ? [`${warns} warning${warns === 1 ? "" : "s"}`] : []),
  ];
  const out = [`# samesight-verify: ${result} (${r.mode === "audit" ? "audit" : "policy mode"})`, "", `${counts.length ? `${counts.join(", ")}. ` : ""}Exit code ${r.exitCode}.`];
  if (r.error !== undefined) out.push("", "## Error", "", ...fence(r.error));
  const replays = new Set<string>();
  for (const s of r.sections) {
    out.push("", `## ${inline(s.title)}`, "");
    if (!s.findings.length) out.push("Nothing to report.");
    let listOpen = false;
    for (const f of s.findings) {
      const [head = "", ...rest] = f.detail.split("\n");
      // The row blocks below say what the detail's own lines for the rows say.
      const shown = new Set((f.rows ?? []).flatMap((r) => formatRow(r)).map((l) => l.trim()));
      const more = rest.filter((l) => l.trim() && !shown.has(l.trim()));
      if (!listOpen) {
        if (out.at(-1) !== "") out.push("");
        listOpen = true;
      }
      out.push(`- ${MARK[f.status]} ${inline(f.check)}: ${inline(head)}`);
      if (more.length) out.push(...fence(dedent(more)).map((l) => `  ${l}`));
      const replay = f.replay !== undefined && !replays.has(f.replay) ? f.replay : undefined;
      if (!f.rows?.length && replay === undefined) continue;
      listOpen = false;
      for (const row of f.rows ?? []) out.push("", ...rowBlock(row));
      if (replay !== undefined) {
        replays.add(replay);
        out.push("", "Replay:", "", ...fence(replay, "sh"));
      }
      out.push("");
    }
  }
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}
