/** One result line, as `samesight doctor` prints them. */
export interface Finding {
  status: "ok" | "warn" | "fail";
  check: string;
  detail: string;
  /** A fail that says the check could not run (a service broke down), not that it found something. */
  incomplete?: boolean;
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
