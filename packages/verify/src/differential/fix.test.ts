import { describe, expect, it } from "vitest";
import { ownerColumn, suggestFix } from "./fix.ts";

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
