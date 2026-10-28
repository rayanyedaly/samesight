import { describe, expect, it } from "vitest";
import { exitCode, type Finding, failed, formatFindings, formatRow, formatRows, formatSection, type RowReport } from "./report.ts";

describe("report", () => {
  it("fails only on a fail, never on warnings", () => {
    expect(failed([{ status: "ok", check: "a", detail: "x" }, { status: "warn", check: "b", detail: "y" }])).toBe(false);
    expect(failed([{ status: "warn", check: "b", detail: "y" }, { status: "fail", check: "c", detail: "z" }])).toBe(true);
    expect(failed([])).toBe(false);
  });

  it("prints one marked line per finding", () => {
    expect(formatFindings([{ status: "fail", check: "anon", detail: "anon has SELECT on Tenant" }])).toBe("FAIL  anon: anon has SELECT on Tenant");
  });

  it("prints a replay once, under the finding's row blocks, its command where their values start", () => {
    const detail = "devices and RLS disagree (seed 9):\n    leak: u1 received lists 5a3e\n      sent by    stream user_data";
    expect(
      formatFindings([
        { status: "fail", check: "differential", detail, replay: "samesight-verify audit --runs 3 --seed 9" },
        { status: "warn", check: "differential", detail: "RLS lets users read rows no stream sends them" },
      ]).split("\n"),
    ).toEqual([
      "FAIL  differential: devices and RLS disagree (seed 9):",
      "    leak: u1 received lists 5a3e",
      "      sent by    stream user_data",
      "      replay     samesight-verify audit --runs 3 --seed 9",
      "warn  differential: RLS lets users read rows no stream sends them",
    ]);
  });
});

describe("formatSection", () => {
  const findings: Finding[] = [
    { status: "ok", check: "streams", detail: "1 stream, 1 query, sending tasks" },
    { status: "fail", check: "user metadata", detail: "reads user_metadata" },
  ];

  it("prints the title, then the findings' lines, with no blank line around them", () => {
    expect(formatSection("Sync config", findings)).toBe("Sync config\nok    streams: 1 stream, 1 query, sending tasks\nFAIL  user metadata: reads user_metadata");
  });

  it("leaves the title plain and colours the findings as formatFindings does", () => {
    expect(formatSection("Sync config", findings, true)).toBe(`Sync config\n${formatFindings(findings, true)}`);
  });
});

describe("formatFindings in colour", () => {
  const row: RowReport = {
    kind: "leak",
    summary: "",
    user: { label: "u1", id: "u1" },
    table: "lists",
    id: "5a3e",
    row: "lists 5a3e (owner_id u0)",
    sentBy: [{ stream: "user_data", query: "queries[0]", sql: "SELECT * FROM lists" }],
    policies: [{ name: "owned lists", permissive: true, verdict: "refuses" }],
    fix: { query: "queries[0]", add: "WHERE owner_id = auth.user_id()", why: 'queries[0] has no owner_id filter, which policy "owned lists" has' },
  };
  const findings: Finding[] = [
    { status: "ok", check: "streams", detail: "2 streams" },
    { status: "warn", check: "claims", detail: "a claim is not tested" },
    { status: "fail", check: "differential", detail: `devices and RLS disagree (seed 1842, shrunk 3 times to 4 rows):\n${formatRows([row])}`, rows: [row], replay: "samesight-verify audit --runs 3 --seed 1842" },
  ];
  // Scripts grep this text: without colour it must not change by a byte.
  const plain = [
    "ok    streams: 2 streams",
    "warn  claims: a claim is not tested",
    "FAIL  differential: devices and RLS disagree (seed 1842, shrunk 3 times to 4 rows):",
    "    leak: u1 received lists 5a3e (owner_id u0); RLS returns no such row for this user",
    "      sent by    stream user_data, queries[0]",
    "                 SELECT * FROM lists",
    '      refused by policy "owned lists" on lists',
    '      likely fix queries[0] has no owner_id filter, which policy "owned lists" has; add',
    "                 WHERE owner_id = auth.user_id()",
    "      replay     samesight-verify audit --runs 3 --seed 1842",
  ].join("\n");
  const strip = (s: string) => s.split("\x1b").map((p, i) => (i === 0 ? p : p.replace(/^\[\d+m/, ""))).join("");

  it("is plain text by default and with colour off", () => {
    expect(formatFindings(findings)).toBe(plain);
    expect(formatFindings(findings, false)).toBe(plain);
    expect(formatRows([row], false)).not.toContain("\x1b");
  });

  it("marks each status with a colour and a symbol, the same width as plain, and dims the labels", () => {
    const out = formatFindings(findings, true);
    expect(out).toContain("\x1b[32m✓ ok\x1b[39m  ");
    expect(out).toContain("\x1b[33m! warn\x1b[39m");
    expect(out).toContain("\x1b[31m✗ FAIL\x1b[39m");
    for (const name of ["sent by", "refused by", "likely fix", "replay"]) expect(out).toContain(`\x1b[2m${name}\x1b[22m`);
    // With the codes taken out, only the symbols are new.
    expect(strip(out)).toBe(
      plain
        .split("\n")
        .map((l) => l.replace(/^(ok {2}|warn|FAIL)/, (m) => `${{ "ok  ": "✓ ok  ", warn: "! warn", FAIL: "✗ FAIL" }[m]}`))
        .join("\n"),
    );
  });

  it("leaves a detail as it is when its blocks are not the rows'", () => {
    const out = formatFindings([{ status: "fail", check: "differential", detail: "a detail of its own", rows: [row] }], true);
    expect(strip(out)).toBe("✗ FAIL  differential: a detail of its own");
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
    expect(formatRow(leak)).toEqual([
      "leak: u1 (app_metadata.role=editor) received lists 5a3e (owner_id u0); RLS returns no such row for this user",
      "  sent by    stream user_data",
      "             stream shared, queries[1]",
    ]);
    // A query put down to its SQL shows it under the stream, on one line.
    expect(formatRow({ ...leak, sentBy: [{ stream: "user_data", query: "queries[0]", sql: "SELECT *\n  FROM lists" }] }).slice(1)).toEqual([
      "  sent by    stream user_data, queries[0]",
      "             SELECT * FROM lists",
    ]);
    expect(formatRow({ ...leak, kind: "hidden", columns: ["notes"], user: { ...leak.user, role: "viewer" } })[0]).toBe("hidden: u1 (app_metadata.role=editor) received lists 5a3e (owner_id u0) with notes, which the policy hides from viewer");
    // A leak no permissive policy allows names each of them; a note goes last.
    const refused = { ...leak, sentBy: [], policies: [{ name: "a", permissive: true, verdict: "refuses" as const }, { name: "b", permissive: true, verdict: "refuses" as const }, { name: "r", permissive: false, verdict: "allows" as const }] };
    expect(formatRow(refused).slice(1)).toEqual(['  refused by policy "a" on lists', '             policy "b" on lists']);
    expect(formatRow({ ...leak, sentBy: [], policies: [], policiesNote: "no permissive read policy" }).slice(1)).toEqual(["  policies   no permissive read policy"]);
    // A likely fix goes last, the clause to add on a line of its own.
    expect(formatRow({ ...leak, sentBy: [], fix: { query: "queries[0]", add: "WHERE owner_id = auth.user_id()", why: 'queries[0] has no owner_id filter, which policy "owned lists" has' } }).slice(1)).toEqual([
      '  likely fix queries[0] has no owner_id filter, which policy "owned lists" has; add',
      "             WHERE owner_id = auth.user_id()",
    ]);
    // A gap was sent by nothing.
    expect(formatRow({ ...leak, kind: "gap", sentBy: [] })).toEqual(["gap: RLS lets u1 (app_metadata.role=editor) read lists 5a3e (owner_id u0), but no stream sent it"]);
  });
});
