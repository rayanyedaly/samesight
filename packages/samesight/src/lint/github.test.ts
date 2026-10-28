import { describe, expect, it } from "vitest";
import { escapeData, escapeProperty, formatGithub } from "./github.ts";

describe("formatGithub", () => {
  it("prints one workflow command per finding, at its line and column when known", () => {
    const out = formatGithub({
      kept: [
        { rule: "not-auto-subscribed", level: "info", file: "s.yaml", line: 3, message: "stream s is not auto_subscribe" },
        { rule: "unscoped-query", level: "error", file: "./powersync/s.yaml", line: 6, column: 12, message: "every row" },
        { rule: "rls-off", level: "warning", file: "s.yaml", message: "file-wide" },
      ],
      allowed: [],
      unreadable: [],
    });
    expect(out.split("\n")).toEqual([
      "::error file=powersync/s.yaml,line=6,col=12,title=samesight unscoped-query::every row",
      "::warning file=s.yaml,title=samesight rls-off::file-wide",
      "::notice file=s.yaml,line=3,title=samesight not-auto-subscribed::stream s is not auto_subscribe",
    ]);
  });

  it("counts allowed findings instead of printing them, and reports files it could not read", () => {
    const allowed = { rule: "unscoped-query", level: "warning" as const, file: "s.yaml", message: "m" };
    expect(formatGithub({ kept: [], allowed: [allowed, allowed], unreadable: [{ file: "bad.yaml", error: "no streams: section" }] }).split("\n")).toEqual([
      "::error file=bad.yaml::could not read: no streams: section",
      "::notice::2 findings allowed by --allow",
    ]);
    expect(formatGithub({ kept: [], allowed: [], unreadable: [] })).toBe("");
  });

  it("escapes messages and property values so each command stays one line", () => {
    expect(escapeData("100% of rows\r\nevery: one, all")).toBe("100%25 of rows%0D%0Aevery: one, all");
    expect(escapeProperty("a,b:c%d\ne")).toBe("a%2Cb%3Ac%25d%0Ae");
    const out = formatGithub({ kept: [{ rule: "rls-open", level: "warning", file: "dir,1/a:b.yaml", line: 1, column: 1, message: "policy \"x\"\n::error::forged 50%" }], allowed: [], unreadable: [] });
    expect(out).toBe('::warning file=dir%2C1/a%3Ab.yaml,line=1,col=1,title=samesight rls-open::policy "x"%0A::error::forged 50%25');
  });
});
