/** Imports a policy file as written, on Node's built-in TypeScript support. */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPolicy, type Policy } from "./policy.ts";

export async function loadPolicy(path: string): Promise<Policy> {
  if (!existsSync(path)) throw new Error(`No policy file at ${path}; run \`samesight init\`.`);
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (!isPolicy(mod.default)) throw new Error(`${path} must \`export default definePolicy(...)\`.`);
  return mod.default;
}
