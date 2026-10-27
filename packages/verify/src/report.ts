/** One result line, as `samesight doctor` prints them. */
export interface Finding {
  status: "ok" | "warn" | "fail";
  check: string;
  detail: string;
  /** A fail that says the check could not run (a service broke down), not that it found something. */
  incomplete?: boolean;
  /** The rows a differential finding is about, as bug reports. */
  rows?: RowReport[];
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
}

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
  const sent = r.sentBy.map((x) => (x.query ? `stream ${x.stream}, ${x.query}` : `stream ${x.stream}`)).join("; ");
  return [`${r.kind}: ${rowSentence(r)}`, ...(sent ? [`  sent by    ${sent}`] : [])];
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${MARK[f.status]}  ${f.check}: ${f.detail}`).join("\n");
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
