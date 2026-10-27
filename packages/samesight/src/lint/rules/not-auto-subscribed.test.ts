import { describe, expect, it } from "vitest";
import { corpusFindings } from "../../fixtures/corpus.ts";
import { lintSyncConfig } from "../lint.ts";
import { notAutoSubscribed } from "./not-auto-subscribed.ts";

const lint = (yaml: string) => lintSyncConfig(yaml, "s.yaml", [notAutoSubscribed]).map((f) => [f.level, f.line, f.message]);

describe("not-auto-subscribed", () => {
  it("notes a stream devices only get when the app subscribes, and nothing else", () => {
    expect(lint("config:\n  edition: 3\nstreams:\n  on_demand:\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list')\n  always:\n    auto_subscribe: true\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id()\n")).toEqual([
      ["info", 5, "stream on_demand is not auto_subscribe: devices get its rows only when the app subscribes, with the parameters it sends, and audit does not test it"],
    ]);
  });

  it("does not apply to sync rules, whose buckets always sync", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS u\n    data: [SELECT * FROM lists WHERE owner_id = bucket.u]\n")).toEqual([]);
  });

  it("notes the one on-demand stream in the corpus", () => {
    expect(corpusFindings("real", [notAutoSubscribed])).toEqual(["powersync-js-time-based.yaml:7 info"]);
  });
});
