/**
 * The manifest records a hash of every file generate wrote. A file that no longer matches
 * was edited by hand, so the verifier would be checking rules the policy never stated.
 */

import { createHash } from "node:crypto";
import type { Finding } from "../report.ts";

/** samesight/manifest.json: what the verifier needs to know about the policy. */
export interface Manifest {
  generator: string;
  claims: { tenant: string; role: string; roles: string[] };
  membership: { table: string; user: string; tenant: string; role: string };
  tenantTable: string | null;
  tables: {
    name: string;
    tenant: string;
    read: Record<string, unknown>;
    insert: Record<string, unknown>;
    update: Record<string, unknown>;
    delete: Record<string, unknown>;
    hide: Record<string, string[]>;
    appendOnly: object | null;
  }[];
  outputs: Record<string, string>;
}

/** `read(path)` returns a generated file's text, or null when it is missing; "migration" is the latest generated migration. */
export function checkManifest(m: Manifest, read: (path: string) => string | null): Finding[] {
  const check = "manifest";
  if (m.generator !== "samesight") return [{ status: "fail", check, detail: "not a samesight manifest" }];
  const out: Finding[] = [];
  for (const [path, hash] of Object.entries(m.outputs)) {
    const text = read(path);
    const name = path === "migration" ? "the latest generated migration" : path;
    if (text === null) out.push({ status: "fail", check, detail: `${name} is missing` });
    else if (createHash("sha256").update(text).digest("hex") !== hash) {
      out.push({ status: "fail", check, detail: `${name} differs from what the policy generated; run samesight generate` });
    }
  }
  if (!out.length) out.push({ status: "ok", check, detail: `all ${Object.keys(m.outputs).length} generated files match the manifest` });
  return out;
}
