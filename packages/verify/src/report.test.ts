import { describe, expect, it } from "vitest";
import { failed, formatFindings } from "./report.ts";

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
