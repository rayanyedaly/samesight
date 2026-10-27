import { describe, expect, it } from "vitest";
import { exitCode, type Finding, failed, formatFindings, formatRow, type RowReport } from "./report.ts";

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

describe("formatRow", () => {
  const leak: RowReport = {
    kind: "leak",
    summary: "",
    user: { label: "u1 (app_metadata.role=editor)", id: "u1" },
    table: "lists",
    id: "5a3e",
    row: "lists 5a3e (owner_id u0)",
    sentBy: [{ stream: "user_data" }, { stream: "shared", query: "queries[1]" }],
  };

  it("says what happened, then which streams sent it, each on its own line", () => {
    expect(formatRow(leak)).toEqual(["leak: u1 (app_metadata.role=editor) received lists 5a3e (owner_id u0); RLS returns no such row for this user", "  sent by    stream user_data; stream shared, queries[1]"]);
    expect(formatRow({ ...leak, kind: "hidden", columns: ["notes"], user: { ...leak.user, role: "viewer" } })[0]).toBe("hidden: u1 (app_metadata.role=editor) received lists 5a3e (owner_id u0) with notes, which the policy hides from viewer");
    // A gap was sent by nothing.
    expect(formatRow({ ...leak, kind: "gap", sentBy: [] })).toEqual(["gap: RLS lets u1 (app_metadata.role=editor) read lists 5a3e (owner_id u0), but no stream sent it"]);
  });
});
