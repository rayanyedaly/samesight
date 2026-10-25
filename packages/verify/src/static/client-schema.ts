/**
 * The client schema must name every synced table, or the app cannot query rows that
 * reach the device. Read from the generated file's text: the Schema's table list and
 * each `const X = new Table({ ... })` block's columns.
 */

import type { IR } from "samesight/compiler";
import type { Finding } from "../report.ts";

export function readClientSchema(source: string): Map<string, Set<string> | null> {
  const tables = new Map<string, Set<string> | null>();
  const schema = /new Schema\(\{([\s\S]*?)\}\)/.exec(source);
  if (!schema) throw new Error("no `new Schema({ ... })` found");
  const blocks = new Map<string, Set<string>>();
  for (const m of source.matchAll(/const (\w+) = new Table\(\{([\s\S]*?)\}\)/g)) {
    blocks.set(m[1] as string, new Set([...(m[2] as string).matchAll(/^\s*("[^"]+"|[\w$]+):/gm)].map((c) => JSON.parse(quote(c[1] as string)))));
  }
  for (const entry of (schema[1] as string).split(",")) {
    const m = /^\s*([\w$]+|"[^"]+")\s*(?::\s*([\w$]+))?/.exec(entry.replace(/\/\/.*$/gm, ""));
    if (!m?.[1]) continue;
    const name = JSON.parse(quote(m[1]));
    tables.set(name, blocks.get(m[2] ?? name) ?? null);
  }
  return tables;
}

const quote = (key: string) => (key.startsWith('"') ? key : JSON.stringify(key));

export function checkClientSchema(ir: IR, file: string, source: string): Finding[] {
  const check = "client schema";
  let tables: Map<string, Set<string> | null>;
  try {
    tables = readClientSchema(source);
  } catch (e) {
    return [{ status: "fail", check, detail: `${file}: ${(e as Error).message}` }];
  }
  const out: Finding[] = [];
  const synced = ir.tables.filter((t) => t.read.size > 0);
  for (const t of synced) {
    const columns = tables.get(t.name);
    if (columns === undefined) {
      out.push({ status: "fail", check, detail: `${file} has no ${t.name} table; its synced rows are invisible to the app` });
      continue;
    }
    // Defined elsewhere (imported): the columns cannot be read here.
    if (columns === null) continue;
    const missing = t.columns.filter((c) => c.name !== "id" && !columns.has(c.name)).map((c) => c.name);
    if (missing.length) out.push({ status: "warn", check, detail: `${file}: ${t.name} lacks ${missing.join(", ")}, which sync but the app cannot read` });
  }
  if (!out.some((f) => f.status === "fail")) out.unshift({ status: "ok", check, detail: `${file} covers all ${synced.length} synced tables` });
  return out;
}
