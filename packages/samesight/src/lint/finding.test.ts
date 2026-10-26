import { describe, expect, it } from "vitest";
import { exitCode, formatLint, type LintFinding, summary } from "./finding.ts";

const finding = (over: Partial<LintFinding>): LintFinding => ({ rule: "unscoped-query", level: "error", file: "sync-config.yaml", message: "m", ...over });

describe("formatLint", () => {
  it("prints each finding at its line, sorted by file, line and level, then a summary", () => {
    const text = formatLint([
      finding({ file: "b.yaml", line: 3, message: "third" }),
      finding({ line: 9, level: "warning", rule: "not-auto-subscribed", message: "second" }),
      finding({ line: 9, message: "first" }),
      finding({ level: "info", rule: "rls-off", file: "a.sql", message: "file-wide" }),
    ]);
    expect(text.split("\n")).toEqual([
      "a.sql  info     file-wide  (rls-off)",
      "b.yaml:3  error    third  (unscoped-query)",
      "sync-config.yaml:9  error    first  (unscoped-query)",
      "sync-config.yaml:9  warning  second  (not-auto-subscribed)",
      "2 errors, 1 warning, 1 note",
    ]);
  });

  it("says when there is nothing to report", () => {
    expect(formatLint([])).toBe("No problems found.");
    expect(summary([finding({ level: "warning" })])).toBe("1 warning");
  });
});

describe("exitCode", () => {
  it("fails on an error only", () => {
    expect(exitCode([finding({ level: "warning" }), finding({ level: "info" })])).toBe(0);
    expect(exitCode([finding({})])).toBe(1);
    expect(exitCode([])).toBe(0);
  });
});
