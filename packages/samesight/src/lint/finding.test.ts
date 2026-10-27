import { describe, expect, it } from "vitest";
import { applyAllow, exitCode, formatLint, type LintFinding, summary } from "./finding.ts";

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

describe("applyAllow", () => {
  it("allows a whole rule, or its findings about one named stream, bucket, table or policy", () => {
    const a = finding({ rule: "unscoped-query", subjects: ["global", "customers"] });
    const b = finding({ rule: "unscoped-query", subjects: ["user_data", "todos"] });
    const c = finding({ rule: "rls-off", subjects: ["Notes"] });
    expect(applyAllow([a, b, c], ["unscoped-query:customers"])).toEqual({ kept: [b, c], allowed: [a] });
    expect(applyAllow([a, b, c], ["unscoped-query"])).toEqual({ kept: [c], allowed: [a, b] });
    // Names match as written: a quoted table keeps its case.
    expect(applyAllow([c], ["rls-off:notes"]).allowed).toEqual([]);
    expect(applyAllow([a, b, c], [])).toEqual({ kept: [a, b, c], allowed: [] });
  });
});
