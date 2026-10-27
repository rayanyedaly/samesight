import { describe, expect, it } from "vitest";
import { tokenize } from "./sql.ts";

const texts = (sql: string, dialect?: "sync" | "postgres") => tokenize(sql, dialect ? { dialect } : {}).map((t) => t.text);

describe("tokenize", () => {
  it("refuses what stream SQL never has, by default", () => {
    expect(() => tokenize("x = ANY (ARRAY['a'])")).toThrow(/has "\['"/);
    expect(() => tokenize("name ~~ 'a%'")).toThrow(/has "~~"/);
    expect(() => tokenize("select 1;")).toThrow(/has ";"/);
  });

  it("reads Postgres's own printing of policies in the postgres dialect", () => {
    expect(texts("(((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = ANY (ARRAY['admin'::text, 'editor'::text]))", "postgres")).toEqual([
      "(", "(", "(", "auth", ".", "jwt", "(", ")", "->", "app_metadata", "::", "text", ")", "->>", "role", "::", "text", ")",
      "=", "any", "(", "array", "[", "admin", "::", "text", ",", "editor", "::", "text", "]", ")", ")",
    ]);
    expect(texts("x::text[] && y", "postgres")).toEqual(["x", "::", "text", "[", "]", "&&", "y"]);
  });

  it("reads any operator as one symbol, and a statement's ending ;", () => {
    expect(texts("a ~~ 'x%' and b !~~* 'y' and c @> d and e ? 'k' and f #>> '{a}' and g % 2 = 0", "postgres")).toEqual([
      "a", "~~", "x%", "and", "b", "!~~*", "y", "and", "c", "@>", "d", "and", "e", "?", "k", "and", "f", "#>>", "{a}", "and", "g", "%", "2", "=", "0",
    ]);
    expect(texts("select auth.jwt() ->> 'role';", "postgres")).toEqual(["select", "auth", ".", "jwt", "(", ")", "->>", "role", ";"]);
  });

  it("keeps the shared symbols and still refuses block comments and $ quoting", () => {
    expect(texts("a <> b and c != d and e::int <= 3 and f || g", "postgres")).toEqual(["a", "<>", "b", "and", "c", "!=", "d", "and", "e", "::", "int", "<=", "3", "and", "f", "||", "g"]);
    expect(() => tokenize("a /* b */", { dialect: "postgres" })).toThrow(/has "\/\*"/);
    expect(() => tokenize("$$ select 1 $$", { dialect: "postgres" })).toThrow(/has "\$\$"/);
  });

  it("splits operators where Postgres's lexer does", () => {
    expect(texts("x=-1 and a<-1 and b>=-1 and c*-d and e !=-1", "postgres")).toEqual([
      "x", "=", "-", "1", "and", "a", "<", "-", "1", "and", "b", ">=", "-", "1", "and", "c", "*", "-", "d", "and", "e", "!=-", "1",
    ]);
    expect(texts("a -- c\n= b", "postgres")).toEqual(["a", "=", "b"]);
    expect(texts("x =-- c\n 1", "postgres")).toEqual(["x", "=", "1"]);
    expect(() => tokenize("x=/* c */1", { dialect: "postgres" })).toThrow(/has "\/\*"/);
    expect(texts("(x = (-1))", "postgres")).toEqual(["(", "x", "=", "(", "-", "1", ")", ")"]);
  });

  it("reads an array slice's colon inside brackets, a cast beside it, and no colon outside", () => {
    expect(texts("(tags)[1:2] = x::text[]", "postgres")).toEqual(["(", "tags", ")", "[", "1", ":", "2", "]", "=", "x", "::", "text", "[", "]"]);
    expect(texts("a[:2] || a[1:] || a[i::int:j]", "postgres")).toEqual(["a", "[", ":", "2", "]", "||", "a", "[", "1", ":", "]", "||", "a", "[", "i", "::", "int", ":", "j", "]"]);
    expect(() => tokenize("v := 1", { dialect: "postgres" })).toThrow(/has ":="/);
  });

  it("reads every numeric constant Postgres does", () => {
    expect(texts("x = 1e2 or x = 1.5E-3 or x = .5 or x = 1.", "postgres").filter((t) => /^[.0-9]/.test(t))).toEqual(["1e2", "1.5E-3", ".5", "1."]);
  });
});
