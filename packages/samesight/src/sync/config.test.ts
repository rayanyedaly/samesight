import { describe, expect, it } from "vitest";
import { parseSyncConfig } from "./config.ts";
import { auditScope } from "./scope.ts";

// PowerSync's to-do list demo, as its sync rules were written before sync streams.
const rules = `
bucket_definitions:
  user_lists:
    parameters: SELECT id as list_id FROM lists WHERE owner_id = request.user_id()
    data:
      - SELECT * FROM lists WHERE id = bucket.list_id
      - SELECT * FROM todos WHERE list_id = bucket.list_id
  global:
    data:
      - SELECT * FROM announcements
`;

describe("parseSyncConfig", () => {
  it("reads bucket definitions as auto-subscribed streams", () => {
    const config = parseSyncConfig(rules);
    expect(config.kind).toBe("bucket definitions");
    expect(config.findings).toEqual([]);
    expect(config.streams.map((s) => [s.name, s.autoSubscribe, [...s.ctes.keys()], s.queries.map((q) => q.label)])).toEqual([
      ["user_lists", true, ["parameters[0]"], ["data[0]", "data[1]"]],
      ["global", true, [], ["data[0]"]],
    ]);
    const scope = auditScope(config.streams, config.kind);
    expect(scope.synced).toEqual(["announcements", "lists", "todos"]);
    expect(scope.findings).toEqual([{ status: "ok", check: "sync rules", detail: "2 bucket definitions, 3 queries, sending announcements, lists, todos" }]);
  });

  it("still reads sync streams", () => {
    const config = parseSyncConfig("config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    query: SELECT * FROM lists\n");
    expect(config.kind).toBe("streams");
    expect(config.streams[0]?.queries[0]?.sql).toBe("SELECT * FROM lists");
  });

  it("warns about client parameters, which the client controls", () => {
    const config = parseSyncConfig(`
bucket_definitions:
  by_list:
    parameters: SELECT request.parameters() ->> 'list_id' as list_id
    data: [SELECT * FROM todos WHERE list_id = bucket.list_id]
`);
    expect(config.findings[0]).toMatchObject({ status: "warn", check: "sync config" });
    expect(config.findings[0]?.detail).toMatch(/by_list reads client parameters/);
    const legacy = parseSyncConfig("bucket_definitions:\n  b:\n    parameters: SELECT user_parameters.list_id AS list_id\n    data: [SELECT * FROM todos WHERE list_id = bucket.list_id]\n");
    expect(legacy.findings[0]?.status).toBe("warn");
  });

  it("refuses what it cannot read in full", () => {
    expect(() => parseSyncConfig("streams: {}\nbucket_definitions: {}\n")).toThrow(/both streams and bucket_definitions/);
    expect(() => parseSyncConfig("bucket_definitions:\n  a:\n    data: []\n")).toThrow(/a has no data queries/);
    expect(() => parseSyncConfig("bucket_definitions:\n  a:\n    data: [1]\n")).toThrow(/data must be a SQL string/);
    expect(() => parseSyncConfig("bucket_definitions:\n  a:\n    query: SELECT 1\n    data: [SELECT * FROM t]\n")).toThrow(/a has query/);
    expect(() => parseSyncConfig("bucket_definitions: {}\nextra: 1\n")).toThrow(/has extra/);
  });
});

describe("client-chosen stream parameters", () => {
  it("warns about streams whose rows depend on what the client asks for", () => {
    const config = parseSyncConfig(
      "config:\n  edition: 3\nstreams:\n  list:\n    auto_subscribe: true\n    query: SELECT * FROM todos WHERE list_id = connection.parameter('list_id')\n",
    );
    expect(config.findings).toEqual([
      expect.objectContaining({ status: "warn", check: "sync config", detail: expect.stringMatching(/^list reads client parameters \(connection.parameter/) }),
    ]);
  });
});
