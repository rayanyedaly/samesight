import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sql.ts";

describe("splitSqlStatements", () => {
  it("keeps semicolons inside comments, literals, quoted names and dollar bodies", () => {
    const sql = `-- prose; with a semicolon
create policy "a; b" on t using (x = 'y;z');
/* block; comment */ select 1;
create function f() returns void language plpgsql as $$ begin perform 1; end $$;
do $body$ begin raise notice 'it''s; fine'; end $body$;
-- trailing comment only`;
    expect(splitSqlStatements(sql)).toEqual([
      `-- prose; with a semicolon\ncreate policy "a; b" on t using (x = 'y;z')`,
      "/* block; comment */ select 1",
      "create function f() returns void language plpgsql as $$ begin perform 1; end $$",
      "do $body$ begin raise notice 'it''s; fine'; end $body$",
    ]);
  });

  it("splits Fieldbook's generated migration into whole statements", () => {
    const dir = new URL("../../../examples/fieldbook/supabase/migrations/", import.meta.url);
    const latest = readdirSync(dir).filter((f) => f.endsWith("_samesight.sql")).sort().at(-1) as string;
    const sql = readFileSync(new URL(latest, dir), "utf8");
    const statements = splitSqlStatements(sql);
    expect(statements.length).toBeGreaterThan(80);
    expect(statements.filter((s) => /create or replace function public\.apply_batch/.test(s))).toHaveLength(1);
    // Every statement ends a top-level construct, never mid-body.
    for (const s of statements) expect(s.split("$$").length % 2, s.slice(0, 80)).toBe(1);
  });
});
