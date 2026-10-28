import { describe, expect, it } from "vitest";
import { code, fence, inline, toMarkdown } from "./markdown.ts";
import { type Finding, formatRow, type RowReport } from "./report.ts";

const statics: Finding[] = [
  { status: "ok", check: "sync config", detail: "2 streams read" },
  { status: "warn", check: "streams", detail: "stream shared is not auto_subscribe: skipped" },
];

const leak: RowReport = {
  kind: "leak",
  summary: "",
  user: { label: "u1", id: "00000000-0000-4000-8000-000000000001" },
  table: "lists",
  id: "5a3e",
  row: "lists 5a3e (owner_id u0)",
  sentBy: [{ stream: "user_data", query: "queries[0]", sql: "SELECT * FROM lists" }],
  policies: [{ name: "owned lists", permissive: true, verdict: "refuses" }],
  fix: { query: "queries[0]", add: "WHERE owner_id = auth.user_id()", why: 'queries[0] has no owner_id filter, which policy "owned lists" has' },
};

const gap: RowReport = {
  kind: "gap",
  summary: "",
  user: { label: "u2 (app_metadata.role=viewer)", id: "00000000-0000-4000-8000-000000000002" },
  table: "todos",
  id: "77",
  row: "todos 77 (list_id 5a3e)",
  sentBy: [],
  policies: [
    { name: "list todos", permissive: true, verdict: "allows" },
    { name: "own todos", permissive: true, verdict: "refuses" },
  ],
};

/** A differential finding as the run words it: a head line, then the rows' blocks indented. */
const differential = (status: Finding["status"], head: string, rows: RowReport[], extra = ""): Finding => ({
  status,
  check: "differential",
  detail: `${head}\n${rows.flatMap((r) => formatRow(r)).map((l) => `    ${l}`).join("\n")}${extra}`,
  rows,
});

describe("toMarkdown", () => {
  it("says a pass in the title, with each section's findings", () => {
    expect(toMarkdown({ mode: "policy", exitCode: 0, sections: [{ title: "Static checks", findings: statics }, { title: "Mutation", findings: [] }] })).toBe(
      [
        "# samesight-verify: PASSED (policy mode)",
        "",
        "1 warning. Exit code 0.",
        "",
        "## Static checks",
        "",
        "- ok sync config: 2 streams read",
        "- **warn** streams: stream shared is not auto\\_subscribe: skipped",
        "",
        "## Mutation",
        "",
        "Nothing to report.",
        "",
      ].join("\n"),
    );
  });

  it("gives a leak a heading, a table, its query's SQL and the replay", () => {
    const fail = { ...differential("fail", "devices and RLS disagree (seed 1842, shrunk 3 times to 4 rows):", [leak]), replay: "samesight-verify audit --runs 3 --seed 1842" };
    expect(toMarkdown({ mode: "audit", exitCode: 1, sections: [{ title: "Static checks", findings: statics }, { title: "Differential (4 users, 3 datasets)", findings: [fail] }] })).toBe(
      [
        "# samesight-verify: FAILED (audit)",
        "",
        "1 failing, 1 warning. Exit code 1.",
        "",
        "## Static checks",
        "",
        "- ok sync config: 2 streams read",
        "- **warn** streams: stream shared is not auto\\_subscribe: skipped",
        "",
        "## Differential (4 users, 3 datasets)",
        "",
        "- **FAIL** differential: devices and RLS disagree (seed 1842, shrunk 3 times to 4 rows):",
        "",
        "### leak: u1 received lists 5a3e (owner\\_id u0); RLS returns no such row for this user",
        "",
        "| | |",
        "| --- | --- |",
        "| User | u1, id `00000000-0000-4000-8000-000000000001` |",
        "| Row | lists 5a3e (owner\\_id u0) |",
        "| Sent by | stream `user_data`, `queries[0]` |",
        "| Refused by | policy `owned lists` on `lists` |",
        '| Likely fix | queries\\[0\\] has no owner\\_id filter, which policy "owned lists" has; add `WHERE owner_id = auth.user_id()` |',
        "",
        "Stream user\\_data, queries\\[0\\]:",
        "",
        "```sql",
        "SELECT * FROM lists",
        "```",
        "",
        "Replay:",
        "",
        "```sh",
        "samesight-verify audit --runs 3 --seed 1842",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("names what let a gap through, and keeps the detail's lines the rows do not say", () => {
    const warn = differential("warn", "RLS lets users read rows no stream sends them, for example:", [gap], "\n    and 3 more");
    expect(toMarkdown({ mode: "audit", exitCode: 0, sections: [{ title: "Differential (4 users, 8 datasets)", findings: [warn, { status: "ok", check: "write path", detail: "no forged write landed" }] }] })).toBe(
      [
        "# samesight-verify: PASSED (audit)",
        "",
        "1 warning. Exit code 0.",
        "",
        "## Differential (4 users, 8 datasets)",
        "",
        "- **warn** differential: RLS lets users read rows no stream sends them, for example:",
        "  ```",
        "  and 3 more",
        "  ```",
        "",
        "### gap: RLS lets u2 (app\\_metadata.role=viewer) read todos 77 (list\\_id 5a3e), but no stream sent it",
        "",
        "| | |",
        "| --- | --- |",
        "| User | u2 (app\\_metadata.role=viewer), id `00000000-0000-4000-8000-000000000002` |",
        "| Row | todos 77 (list\\_id 5a3e) |",
        "| Allowed by | policy `list todos` on `todos` |",
        "",
        "- ok write path: no forged write landed",
        "",
      ].join("\n"),
    );
  });

  it("says a run that could not finish is incomplete, its detail in a block", () => {
    const broke: Finding = { status: "fail", check: "differential", detail: "the run failed: PowerSync stopped answering\n  after 3 datasets", incomplete: true };
    expect(toMarkdown({ mode: "audit", exitCode: 2, sections: [{ title: "Differential (4 users, 3 datasets)", findings: [broke] }] })).toBe(
      [
        "# samesight-verify: INCOMPLETE (audit)",
        "",
        "1 could not run. Exit code 2.",
        "",
        "## Differential (4 users, 3 datasets)",
        "",
        "- **FAIL** differential: the run failed: PowerSync stopped answering",
        "  ```",
        "  after 3 datasets",
        "  ```",
        "",
      ].join("\n"),
    );
  });

  it("gives the error that stopped a run its own section", () => {
    expect(toMarkdown({ mode: "audit", exitCode: 2, sections: [], error: "No sync config at /x/sync-config.yaml; pass --sync-config." })).toBe(
      [
        "# samesight-verify: COULD NOT RUN (audit)",
        "",
        "Exit code 2.",
        "",
        "## Error",
        "",
        "```",
        "No sync config at /x/sync-config.yaml; pass --sync-config.",
        "```",
        "",
      ].join("\n"),
    );
  });
});

describe("escaping", () => {
  it("keeps text, code spans and fences from being read as markup", () => {
    expect(inline("a | b `c` <d> *e*\n  f")).toBe("a \\| b \\`c\\` \\<d\\> \\*e\\* f");
    // In a table cell a code span still needs its pipes escaped; a backtick inside takes a longer run.
    expect(code("a | b")).toBe("`a \\| b`");
    expect(code("x`y")).toBe("``x`y``");
    expect(code("`y")).toBe("`` `y ``");
    expect(fence("select '```'", "sql")).toEqual(["````sql", "select '```'", "````"]);
  });

  it("escapes what a row's values hold in its table", () => {
    const odd = toMarkdown({ mode: "audit", exitCode: 1, sections: [{ title: "D", findings: [differential("fail", "x:", [{ ...leak, row: "lists 1 (title a|b`c)", sentBy: [{ stream: "s|t" }] }])] }] });
    expect(odd).toContain("| Row | lists 1 (title a\\|b\\`c) |");
    expect(odd).toContain("| Sent by | stream `s\\|t` |");
  });
});
