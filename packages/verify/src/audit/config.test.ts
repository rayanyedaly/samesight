import { describe, expect, it } from "vitest";
import { checkSyncConfig, checkUserMetadata } from "./config.ts";

const streams = `streams:
  tasks:
    auto_subscribe: true
    queries:
      - SELECT * FROM tasks WHERE team_id = auth.parameter('user_metadata') ->> 'team_id'
`;

describe("checkSyncConfig", () => {
  it("returns the Sync config section and the parsed config", () => {
    const checked = checkSyncConfig("sync.yaml", streams);
    expect(checked.findings.some((f) => f.check === "streams" && f.status === "ok")).toBe(true);
    expect(checked.parsed?.scope.synced).toEqual(["tasks"]);
    expect(checked.parsed?.streamSql.map((r) => r.where)).toEqual(["tasks.queries[0]"]);
  });

  it("fails a file that is not a sync config, naming its path", () => {
    const checked = checkSyncConfig("sync.yaml", "nothing: here\n");
    expect(checked.parsed).toBeUndefined();
    expect(checked.findings).toHaveLength(1);
    expect(checked.findings[0]).toMatchObject({ status: "fail", check: "sync config" });
    expect(checked.findings[0]?.detail.startsWith("sync.yaml: ")).toBe(true);
  });
});

describe("checkUserMetadata", () => {
  it("reads the RLS policies and the stream queries", () => {
    const streamSql = checkSyncConfig("sync.yaml", streams).parsed?.streamSql ?? [];
    const policy = { table: "tasks", name: "team", qual: "((auth.jwt() -> 'user_metadata') ->> 'team_id') = team_id", with_check: null };
    expect(checkUserMetadata([policy], streamSql).map((f) => [f.status, f.detail.split(" reads ")[0]])).toEqual([
      ["fail", 'policy "team" on tasks'],
      ["fail", "tasks.queries[0]"],
    ]);
    expect(checkUserMetadata([], [])).toMatchObject([{ status: "ok", check: "user metadata" }]);
  });
});
