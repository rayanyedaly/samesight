/**
 * Test helpers over the repository's corpus of real and planted sync configs
 * (corpus/SOURCES.md), for the lint rule tests. Fixtures stay out of the build and the package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LintLevel } from "../lint/finding.ts";
import { type LintRule, lintSyncConfig } from "../lint/lint.ts";

const corpus = fileURLToPath(new URL("../../../../corpus/", import.meta.url));

export function corpusFiles(dir: "real" | "planted"): { file: string; text: string }[] {
  return readdirSync(join(corpus, dir))
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(corpus, dir, file), "utf8") }));
}

/** Planted files whose header says `# Expected: lint <rule> (<level>)` for this rule. */
export function plantedExpecting(rule: string): { file: string; text: string; level: LintLevel }[] {
  return corpusFiles("planted").flatMap((p) => {
    const m = /^# Expected: lint ([a-z-]+) \((error|warning|info)\)/m.exec(p.text);
    return m && m[1] === rule ? [{ ...p, level: m[2] as LintLevel }] : [];
  });
}

/** Each finding the rules give a corpus directory, as "file:line level". */
export function corpusFindings(dir: "real" | "planted", rules: LintRule[]): string[] {
  return corpusFiles(dir).flatMap((c) => lintSyncConfig(c.text, c.file, rules).map((f) => `${f.file}${f.line ? `:${f.line}` : ""} ${f.level}`));
}
