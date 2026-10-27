import type pg from "pg";
import { parseStreams } from "samesight/compiler";
import { describe, expect, it } from "vitest";
import type { RowReport } from "../report.ts";
import { candidates, sendingQueries } from "./attribute.ts";

const streams = parseStreams(`
streams:
  owned:
    auto_subscribe: true
    query: SELECT * FROM lists WHERE owner_id = auth.user_id()
  everyone:
    auto_subscribe: true
    queries:
      - SELECT * FROM lists
      - SELECT * FROM todos
  claimed:
    auto_subscribe: true
    query: SELECT * FROM lists WHERE org_id = auth.jwt() ->> 'org'
  asked:
    query: SELECT * FROM lists
`);

const leak = (sentBy: RowReport["sentBy"]): RowReport => ({ kind: "leak", summary: "", user: { label: "u1", id: "id-1" }, table: "lists", id: "5a3e5a3e-1", row: "lists 5a3e5a3e-1", sentBy });

/** A connection on which a query returns the row only when it has no owner filter. */
function database() {
  const run: string[] = [];
  const client = {
    query: async (text: string) => {
      if (!text.includes("q.id::text = $1")) return { rows: [] };
      run.push(text);
      return { rows: text.includes("owner_id") ? [] : [{ found: 1 }] };
    },
  } as unknown as pg.Client;
  return { client, run };
}

describe("candidates", () => {
  it("takes the queries of auto-subscribed streams that send the table", () => {
    expect(candidates(streams, "lists").map((c) => `${c.stream.name} ${c.label}`)).toEqual(["owned query", "everyone queries[0]", "claimed query"]);
  });
});

describe("sendingQueries", () => {
  it("names the one query of the stream the device named, running nothing", async () => {
    const { client, run } = database();
    const r = leak([{ stream: "everyone" }]);
    await sendingQueries(client, streams, [r], () => ({ sub: "id-1" }));
    expect(r.sentBy).toEqual([{ stream: "everyone", query: "queries[0]", sql: "SELECT * FROM lists" }]);
    expect(run).toEqual([]);
  });

  it("runs each query for the user when the device's streams hold several, and keeps those that return the row", async () => {
    const { client, run } = database();
    const r = leak([{ stream: "owned" }, { stream: "everyone" }]);
    await sendingQueries(client, streams, [r], () => ({ sub: "id-1" }));
    expect(r.sentBy).toEqual([{ stream: "everyone", query: "queries[0]", sql: "SELECT * FROM lists" }]);
    // The claimed stream reads auth.jwt(), which no query here evaluates: it is not run.
    expect(run.map((x) => x.includes("owner_id"))).toEqual([true, false]);
  });

  it("keeps the device's streams when no query can be run for the user", async () => {
    const { client } = database();
    const r = leak([{ stream: "owned" }, { stream: "claimed" }]);
    await sendingQueries(client, streams, [r], () => undefined);
    expect(r.sentBy).toEqual([{ stream: "owned" }, { stream: "claimed" }]);
  });
});
