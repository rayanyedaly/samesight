/** One result line, as `samesight doctor` prints them. */
export interface Finding {
  status: "ok" | "warn" | "fail";
  check: string;
  detail: string;
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${MARK[f.status]}  ${f.check}: ${f.detail}`).join("\n");
}

export function failed(findings: Finding[]): boolean {
  return findings.some((f) => f.status === "fail");
}
