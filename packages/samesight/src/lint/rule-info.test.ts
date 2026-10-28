import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULE_NAMES } from "./lint.ts";
import { RULE_INFO } from "./rule-info.ts";

const docs = readFileSync(new URL("../../../../docs/cli.md", import.meta.url), "utf8");

/** The anchor GitHub gives a heading: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const anchors = new Set([...docs.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1] as string)));

describe("RULE_INFO", () => {
  it("describes every rule, in the order lint runs them", () => {
    expect(Object.keys(RULE_INFO)).toEqual(RULE_NAMES);
    for (const [id, info] of Object.entries(RULE_INFO)) {
      expect(info.summary, id).not.toMatch(/\n/);
      expect(info.description.length, id).toBeGreaterThan(info.summary.length);
      expect(["error", "warning", "info"], id).toContain(info.level);
    }
  });

  it("links each rule to its own heading in docs/cli.md", () => {
    expect(slug("`unscoped-query`")).toBe("unscoped-query");
    expect(slug("Exit codes, and --allow")).toBe("exit-codes-and---allow");
    for (const [id, info] of Object.entries(RULE_INFO)) {
      expect(info.help, id).toBe(`https://github.com/rayanyedaly/samesight/blob/main/docs/cli.md#${id}`);
      expect(anchors, id).toContain(id);
    }
  });
});
