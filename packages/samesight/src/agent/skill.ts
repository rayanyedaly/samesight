/**
 * The samesight skill the package ships (skills/samesight), and where agents read skills in
 * a project. `agent init` copies it there; the hook says when a copy differs from the
 * installed package's.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill's directory in the installed package: the same from src/agent and dist/agent. */
export const SKILL_DIR = fileURLToPath(new URL("../../skills/samesight/", import.meta.url));

/** Where each agent reads the skill, relative to the project. */
export const SKILL_TARGETS = { claude: ".claude/skills/samesight", codex: ".agents/skills/samesight", cursor: ".cursor/skills/samesight" } as const;

/** The skill's files, as paths relative to its directory with / separators, sorted; empty when the package has none. */
export function skillFiles(dir = SKILL_DIR): string[] {
  if (!existsSync(dir)) return [];
  const walk = (d: string): string[] =>
    readdirSync(d)
      .sort()
      .flatMap((name) => {
        const path = join(d, name);
        return statSync(path).isDirectory() ? walk(path) : [relative(dir, path).split("\\").join("/")];
      });
  return walk(dir);
}

/** The installed copies in `root` that differ from the package's skill (a file missing or changed); copies not installed are not counted. */
export function staleCopies(root: string, dir = SKILL_DIR): string[] {
  const files = skillFiles(dir);
  if (!files.length) return [];
  return Object.values(SKILL_TARGETS).filter((target) => {
    const copy = join(root, target);
    if (!existsSync(join(copy, "SKILL.md"))) return false;
    return files.some((f) => {
      const path = join(copy, f);
      return !existsSync(path) || !readFileSync(path).equals(readFileSync(join(dir, f)));
    });
  });
}
