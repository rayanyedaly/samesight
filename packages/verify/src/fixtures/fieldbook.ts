/** Fieldbook, the example app, as the static checks see it: its policy, IR and generated files. */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildIR, loadPolicy, type SchemaInfo } from "samesight/compiler";

export const FIELDBOOK = fileURLToPath(new URL("../../../../examples/fieldbook/", import.meta.url));

export const read = (path: string) => readFileSync(`${FIELDBOOK}${path}`, "utf8");

export const policy = await loadPolicy(`${FIELDBOOK}samesight.policy.ts`);
export const schema = JSON.parse(read("samesight/schema.json")) as SchemaInfo;
export const ir = buildIR(policy, schema);
export const syncConfig = read("powersync/sync-config.yaml");

export function latestMigration(): string {
  const dir = `${FIELDBOOK}supabase/migrations/`;
  const latest = readdirSync(dir).filter((f) => f.endsWith("_samesight.sql")).sort().at(-1);
  if (!latest) throw new Error("Fieldbook has no generated migration");
  return readFileSync(dir + latest, "utf8");
}
