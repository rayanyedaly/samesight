import type pg from "pg";
import { parseStreams } from "samesight/compiler";
import { describe, expect, it } from "vitest";
import type { RowReport } from "../report.ts";
import { likelyFixes, ownerColumn, suggestFix } from "./fix.ts";

describe("ownerColumn", () => {
  it.each([
    ["(owner_id = auth.uid())", "owner_id"],
    ["(auth.uid() = owner_id)", "owner_id"],
    ["(owner_id = ( SELECT auth.uid() AS uid))", "owner_id"],
    ['("ownerId" = auth.uid())', "ownerId"],
  ])("takes %s as the owner filter on %s", (qual, column) => {
    expect(ownerColumn(qual)).toBe(column);
  });

  it.each([
    ["(owner_id <> auth.uid())", "negated"],
    ["((owner_id = auth.uid()) OR is_public)", "an OR"],
    ["((owner_id = auth.uid()) AND (status = 'published'::text))", "another condition"],
    ["(EXISTS ( SELECT 1 FROM members m WHERE ((m.list_id = lists.id) AND (m.user_id = auth.uid()))))", "a subquery"],
    ["((owner_id)::text = (auth.uid())::text)", "casts"],
    ["(lists.owner_id = auth.uid())", "a qualified column"],
    ["((auth.jwt() ->> 'role'::text) = 'admin'::text)", "no user id"],
    ["true", "nothing of the user"],
  ])("refuses %s (%s)", (qual) => {
    expect(ownerColumn(qual)).toBeUndefined();
  });
});

describe("suggestFix", () => {
  const owned = { name: "owned lists", qual: "(owner_id = auth.uid())" };
  const q = (sql: string) => ({ label: "queries[0]", sql });
  const none = new Map<string, string>();

  it("adds the owner filter as WHERE, or AND after the query's own", () => {
    expect(suggestFix(q("SELECT * FROM lists"), none, owned, "lists")).toEqual({
      query: "queries[0]",
      add: "WHERE owner_id = auth.user_id()",
      why: 'queries[0] has no owner_id filter, which policy "owned lists" has',
      sql: "SELECT * FROM lists WHERE owner_id = auth.user_id()",
    });
    expect(suggestFix(q("SELECT * FROM lists WHERE NOT archived"), none, owned, "lists")?.sql).toBe("SELECT * FROM lists WHERE NOT archived AND owner_id = auth.user_id()");
    expect(suggestFix(q("SELECT * FROM lists"), none, { name: "p", qual: '("ownerId" = auth.uid())' }, "lists")?.add).toBe('WHERE "ownerId" = auth.user_id()');
  });

  it.each([
    ["SELECT * FROM lists WHERE owner_id = auth.user_id() OR shared", "an OR"],
    ["SELECT lists.* FROM lists JOIN members ON members.list_id = lists.id", "a join"],
    ["SELECT * FROM lists WHERE id IN (SELECT list_id FROM members)", "a subquery"],
    ["SELECT * FROM lists WHERE id IN mine", "a CTE"],
    ["SELECT * FROM lists WHERE owner_id = auth.user_id() AND archived", "the filter already there"],
    ["SELECT * FROM todos", "another table"],
  ])("suggests nothing for %s (%s)", (sql) => {
    expect(suggestFix(q(sql), new Map([["mine", "SELECT id FROM lists WHERE owner_id = auth.user_id()"]]), owned, "lists")).toBeUndefined();
  });

  it("suggests nothing when the policy is more than the owner filter", () => {
    expect(suggestFix(q("SELECT * FROM lists"), none, { name: "p", qual: "((owner_id = auth.uid()) OR is_public)" }, "lists")).toBeUndefined();
  });
});

describe("likelyFixes", () => {
  it("suggests nothing when another stream has the same query, which shares its bucket and sends the row too", async () => {
    const streams = parseStreams(`
streams:
  mine:
    auto_subscribe: true
    query: SELECT * FROM lists
  also:
    auto_subscribe: true
    query: select *  from lists
`);
    const run: string[] = [];
    const client = {
      query: async (text: string) => {
        run.push(text);
        return { rows: [] };
      },
    } as unknown as pg.Client;
    const leak: RowReport = {
      kind: "leak",
      summary: "",
      user: { label: "u1", id: "id-1" },
      table: "lists",
      id: "5a3e5a3e-1",
      row: "lists 5a3e5a3e-1",
      sentBy: [{ stream: "mine", query: "query", sql: "SELECT * FROM lists" }],
      policies: [{ name: "owned lists", permissive: true, verdict: "refuses" }],
    };
    await likelyFixes(client, { kind: "streams", streams }, [leak], () => ({ sub: "id-1" }));
    expect(leak.fix).toBeUndefined();
    expect(run).toEqual([]);
  });
});
