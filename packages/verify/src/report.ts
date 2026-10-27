/** One result line, as `samesight doctor` prints them. */
export interface Finding {
  status: "ok" | "warn" | "fail";
  check: string;
  detail: string;
  /** A fail that says the check could not run (a service broke down), not that it found something. */
  incomplete?: boolean;
  /** The rows a differential finding is about, as bug reports. */
  rows?: RowReport[];
  /** The command that replays the run, with its own flags and the failing seed. */
  replay?: string;
}

/**
 * One row a user's device and RLS disagree on, as a bug report: who, which row, which way
 * (a leak: the device has a row RLS refuses; hidden: a column the policy hides; a gap: RLS
 * lets them read a row no stream sent; unsent: a column missing from a sent row; differs:
 * a copy unlike the database's), and which streams sent it.
 */
export interface RowReport {
  kind: "leak" | "hidden" | "gap" | "unsent" | "differs";
  /** The sentence the run says it in, streams included. */
  summary: string;
  user: { label: string; id: string; role?: string | null };
  table: string;
  id: string;
  /** The row as the run describes it: its table, id, tenant and the users and values it holds. */
  row: string;
  columns?: string[];
  sentBy: { stream: string; query?: string; sql?: string }[];
  /** For a leak or a gap: the user's RLS read policies on the table, each evaluated on the row. */
  policies?: { name: string; permissive: boolean; verdict: "allows" | "refuses" }[];
  /** Why the policies were not evaluated, or what they say together. */
  policiesNote?: string;
  /** For a leak the narrow rule covers: what to add to which query, checked against the row. */
  fix?: { query: string; add: string; why: string };
}

/** A row block's label, its value starting where the other labels' do. */
const label = (name: string) => `  ${name.padEnd(11)}`;

/** What a row report says happened, with the streams that sent it when `via` is given. */
export function rowSentence(r: Pick<RowReport, "kind" | "user" | "row" | "columns">, via = ""): string {
  const cols = r.columns?.join(", ");
  switch (r.kind) {
    case "leak":
      return `${r.user.label} received ${r.row}${via}; RLS returns no such row for this user`;
    case "hidden":
      return `${r.user.label} received ${r.row} with ${cols}${via}, which the policy hides from ${r.user.role}`;
    case "gap":
      return `RLS lets ${r.user.label} read ${r.row}, but no stream sent it`;
    case "unsent":
      return `${r.user.label}'s copy of ${r.row} lacks ${cols}, which RLS lets them read${via}`;
    case "differs":
      return `${r.user.label}'s copy of ${r.row} differs from the database in ${cols}${via}`;
  }
}

/** A row report's lines: what happened, then where it came from, each under a label. */
export function formatRow(r: RowReport): string[] {
  const blank = " ".repeat(13);
  const sent = r.sentBy.flatMap((x, i) => [
    `${i === 0 ? label("sent by") : blank}stream ${x.stream}${x.query ? `, ${x.query}` : ""}`,
    ...(x.sql ? [`${blank}${x.sql.replace(/\s+/g, " ").trim()}`] : []),
  ]);
  // A leak names what refused the row: the restrictive policies when a permissive one allows it, else every permissive one.
  // A gap names what let the user read it.
  const allows = r.policies?.some((p) => p.permissive && p.verdict === "allows");
  const decided = (r.policies ?? []).filter((p) => (r.kind === "gap" ? p.permissive && p.verdict === "allows" : p.verdict === "refuses" && p.permissive === !allows));
  const by = r.kind === "gap" ? "allowed by" : "refused by";
  const policies = decided.map((p, i) => `${i === 0 ? label(by) : blank}${p.permissive ? "" : "restrictive "}policy "${p.name}" on ${r.table}`);
  const note = r.policiesNote ? [`${label("policies")}${r.policiesNote}`] : [];
  const fix = r.fix ? [`${label("likely fix")}${r.fix.why}; add`, `${blank}${r.fix.add}`] : [];
  return [`${r.kind}: ${rowSentence(r)}`, ...sent, ...policies, ...note, ...fix];
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

/** One line per finding (its detail may hold row blocks), then a replay line under the blocks of a finding with one. */
export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${MARK[f.status]}  ${f.check}: ${f.detail}${f.replay ? `\n    ${label("replay")}${f.replay}` : ""}`).join("\n");
}

export function failed(findings: Finding[]): boolean {
  return findings.some((f) => f.status === "fail");
}

/** 0 when nothing failed, 1 when a check found something, 2 when one only could not run. */
export function exitCode(findings: Finding[]): 0 | 1 | 2 {
  const fails = findings.filter((f) => f.status === "fail");
  if (fails.some((f) => !f.incomplete)) return 1;
  return fails.length ? 2 : 0;
}
