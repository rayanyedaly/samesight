import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULE_NAMES } from "./lint.ts";
import { RULE_INFO } from "./rule-info.ts";

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
const docs = read("docs/cli.md");

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

  it("links each rule to its page on the docs site, built from docs/rules/<id>.md", () => {
    const index = read("docs/rules/index.md");
    for (const [id, info] of Object.entries(RULE_INFO)) {
      expect(info.help, id).toBe(`https://rayanyedaly.github.io/samesight/rules/${id}`);
      expect(existsSync(new URL(`../../../../docs/rules/${id}.md`, import.meta.url)), id).toBe(true);
      const page = read(`docs/rules/${id}.md`);
      expect(page.split("\n")[0], id).toBe(`# ${id}`);
      expect(page, id).toMatch(new RegExp(`^Level: ${info.level}\\b`, "m"));
      // The page may put names in code; the words are RULE_INFO's.
      expect(page.replace(/`/g, ""), id).toContain(info.summary);
      // Its row in the index: the link, the level, the summary.
      const row = index.split("\n").find((line) => line.includes(`](${id}.md)`));
      const cells = (row ?? "").split("|").map((cell) => cell.trim().replace(/`/g, ""));
      expect(cells[2], id).toMatch(new RegExp(`^${info.level}\\b`));
      expect(cells[3], id).toBe(info.summary);
    }
  });

  it("keeps each rule's heading in docs/cli.md, which 0.1.0's links point to", () => {
    expect(slug("`unscoped-query`")).toBe("unscoped-query");
    expect(slug("Exit codes, and --allow")).toBe("exit-codes-and---allow");
    for (const id of Object.keys(RULE_INFO)) {
      expect(anchors, id).toContain(id);
      expect(docs, id).toContain(`](rules/${id}.md)`);
    }
  });
});
