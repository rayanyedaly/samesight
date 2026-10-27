import { describe, expect, it } from "vitest";
import { exitCode, type Finding, failed, formatFindings } from "./report.ts";

describe("report", () => {
  it("fails only on a fail, never on warnings", () => {
    expect(failed([{ status: "ok", check: "a", detail: "x" }, { status: "warn", check: "b", detail: "y" }])).toBe(false);
    expect(failed([{ status: "warn", check: "b", detail: "y" }, { status: "fail", check: "c", detail: "z" }])).toBe(true);
    expect(failed([])).toBe(false);
  });

  it("prints one marked line per finding", () => {
    expect(formatFindings([{ status: "fail", check: "anon", detail: "anon has SELECT on Tenant" }])).toBe("FAIL  anon: anon has SELECT on Tenant");
  });
});

describe("exitCode", () => {
  const f = (status: Finding["status"], incomplete?: true): Finding => ({ status, check: "c", detail: "d", ...(incomplete ? { incomplete } : {}) });

  it("is 0 on a pass, 1 when a check found something, 2 when one only could not run", () => {
    expect(exitCode([])).toBe(0);
    expect(exitCode([f("ok"), f("warn")])).toBe(0);
    expect(exitCode([f("ok"), f("fail")])).toBe(1);
    expect(exitCode([f("fail", true)])).toBe(2);
    // What it found counts for more than what it could not run.
    expect(exitCode([f("fail", true), f("fail")])).toBe(1);
  });
});
