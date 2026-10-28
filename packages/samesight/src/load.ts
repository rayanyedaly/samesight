/** Finds and imports a policy file as written, on Node's built-in TypeScript support. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPolicy, type Policy } from "./policy.ts";

/** Looked for in this order when no `--policy` is given. */
export const POLICY_FILES = ["samesight.policy.ts", "samesight.policy.mts"] as const;

/** The policy file to use: the one given, else the first of POLICY_FILES in `cwd` (the first name if none exists). */
export function resolvePolicyPath(given: string | undefined, cwd = process.cwd()): string {
  if (given !== undefined) return resolve(cwd, given);
  const found = POLICY_FILES.map((f) => join(cwd, f)).find((p) => existsSync(p));
  return found ?? join(cwd, POLICY_FILES[0]);
}

/**
 * Whether a `.ts` file next to `dir` loads as an ES module: its nearest package.json says
 * `"type": "module"`. Without that, Node reparses it (with a warning) or, under
 * `"type": "commonjs"`, refuses its imports; `.mts` always loads as a module.
 */
export function tsIsModule(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const pkg = join(d, "package.json");
    if (existsSync(pkg)) {
      try {
        return (JSON.parse(readFileSync(pkg, "utf8")) as { type?: unknown }).type === "module";
      } catch {
        return false;
      }
    }
    if (dirname(d) === d) return false;
  }
}

export async function loadPolicy(path: string): Promise<Policy> {
  if (!existsSync(path)) throw new Error(`no policy file at ${path}; run samesight init, or pass --policy`);
  if (/\.[cm]?ts$/.test(path) && !(process.features as { typescript?: unknown }).typescript) {
    throw new Error(
      `Node ${process.versions.node} cannot load ${path}: samesight needs Node 22.18 or newer, which runs TypeScript files as they are.`,
    );
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  } catch (e) {
    if (e instanceof SyntaxError && /import statement outside a module|Unexpected token 'export'/.test(e.message)) {
      throw new Error(
        `${path} loads as CommonJS here. Rename it to samesight.policy.mts, or set "type": "module" in package.json.`,
      );
    }
    throw e;
  }
  if (!isPolicy(mod.default)) throw new Error(`${path} must \`export default definePolicy(...)\`.`);
  return mod.default;
}
