import { describe, expect, it } from "vitest";
import { corpusFindings, plantedExpecting } from "../../fixtures/corpus.ts";
import { lintSyncConfig } from "../lint.ts";
import { userMetadata } from "./user-metadata.ts";

const lint = (yaml: string) => lintSyncConfig(yaml, "s.yaml", [userMetadata]).map((f) => [f.level, f.line, f.message]);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;

describe("user-metadata", () => {
  it("fails a stream query or CTE that reads user_metadata from the token", () => {
    expect(lint(stream("  t:\n    query: SELECT * FROM tasks WHERE team_id = auth.parameter('user_metadata') ->> 'team_id'\n"))).toEqual([
      ["error", 5, "stream t, query decides access from user_metadata, which every Supabase user can set on themselves (supabase.auth.updateUser); use app_metadata or a table"],
    ]);
    expect(
      lint(stream("  t:\n    with:\n      teams: SELECT id FROM teams WHERE id = auth.parameters() -> 'user_metadata' ->> 'team'\n    query: SELECT * FROM tasks WHERE team_id IN teams\n")).map(
        (f) => f[2],
      ),
    ).toEqual([expect.stringMatching(/^stream t, with.teams decides access from user_metadata/)]);
  });

  it("fails sync rules that read it through request.jwt(), and a path into it", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.jwt() -> 'user_metadata' ->> 'org' AS org\n    data: [SELECT * FROM t WHERE org = bucket.org]\n").map((f) => f[2])).toEqual([
      expect.stringMatching(/^bucket b, parameters\[0\] decides access/),
    ]);
    // PowerSync reads auth.parameter('x') as the JSON path '$.' || x.
    expect(lint(stream("  t:\n    query: SELECT * FROM tasks WHERE team_id = auth.parameter('user_metadata.team_id')\n"))).toHaveLength(1);
    expect(lint(stream("  t:\n    query: SELECT * FROM tasks WHERE team_id = json_extract(request.jwt(), '$.user_metadata.team')\n"))).toHaveLength(1);
    expect(lint(stream("  t:\n    query: SELECT * FROM tasks WHERE team_id = auth.parameters() ->> '$.user_metadata.team'\n"))).toHaveLength(1);
  });

  it("accepts app_metadata, other claims, legacy token_parameters and plain strings", () => {
    expect(lint(stream("  t:\n    query: SELECT * FROM tasks WHERE team_id = auth.parameter('app_metadata') ->> 'team_id'\n"))).toEqual([]);
    expect(lint(stream("  t:\n    query: SELECT * FROM tasks WHERE owner_id = auth.user_id()\n"))).toEqual([]);
    // token_parameters read the token's own "parameters" claim, which Supabase does not set.
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT token_parameters.user_metadata ->> 'org' AS org\n    data: [SELECT * FROM t WHERE org = bucket.org]\n")).toEqual([]);
    expect(lint(stream("  t:\n    query: SELECT * FROM events WHERE kind = 'user_metadata' AND owner_id = auth.user_id()\n"))).toEqual([]);
  });
});

describe("user-metadata on the corpus", () => {
  it("catches every planted leak that expects it, and nothing in the real configs", () => {
    const planted = plantedExpecting("user-metadata");
    expect(planted.map((p) => p.file)).toEqual(["user-metadata-scope.yaml"]);
    for (const p of planted) expect(lintSyncConfig(p.text, p.file, [userMetadata]).map((f) => f.level), p.file).toContain(p.level);
    expect(corpusFindings("real", [userMetadata])).toEqual([]);
  });
});
