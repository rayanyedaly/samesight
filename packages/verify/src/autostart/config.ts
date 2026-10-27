/**
 * The PowerSync service config for an auto-started run: the one `samesight generate`
 * writes (emitServiceConfig), with the run's own connection strings and replication slot
 * prefix, and the sync config under audit inlined, so the container needs no mounted
 * files. Tokens are checked the way the project's Supabase Auth signs them: against its
 * JWKS when it has a signing key, else with its shared HS256 secret.
 */

import { emitServiceConfig } from "samesight/compiler";
import { parseDocument } from "yaml";

export type Auth = { jwksUri: string } | { jwtSecret: string };

export interface ServiceConfigOptions {
  /** The replication role's connection string, by the database's name on the network. */
  dataSource: string;
  /** The storage container's connection string. */
  storage: string;
  slotPrefix: string;
  syncConfig: string;
  auth: Auth;
}

export function serviceConfig(o: ServiceConfigOptions): string {
  const jwksUri = "jwksUri" in o.auth ? o.auth.jwksUri : "unused";
  // !env reads a variable in PowerSync; here the values are written in, as plain strings.
  const doc = parseDocument(emitServiceConfig({ syncConfigPath: "unused", jwksUri }), { customTags: [{ tag: "!env", resolve: (v: string) => v }] });
  doc.commentBefore = " Written by samesight-verify audit for one run, then removed with its container.";
  doc.setIn(["replication", "connections", 0, "uri"], doc.createNode(o.dataSource));
  doc.setIn(["replication", "connections", 0, "slot_name_prefix"], o.slotPrefix);
  doc.setIn(["storage", "uri"], doc.createNode(o.storage));
  doc.setIn(["sync_config"], doc.createNode({ content: o.syncConfig }));
  if ("jwtSecret" in o.auth) {
    doc.deleteIn(["client_auth", "jwks_uri"]);
    doc.setIn(["client_auth", "supabase_jwt_secret"], o.auth.jwtSecret);
  }
  const text = doc.toString({ lineWidth: 0 });
  return "jwtSecret" in o.auth ? text.replace("against the local project's JWKS.", "with the local project's shared HS256 secret.") : text;
}

/**
 * How PowerSync should check this project's tokens: by its JWKS (read from inside the
 * network, through the API gateway) when Auth publishes a key there, else by the HS256
 * secret `supabase status` prints. `jwks` is what the JWKS endpoint returned, or null.
 */
export function chooseAuth(jwks: unknown, kong: string, jwtSecret: string | undefined): Auth {
  const keys = (jwks as { keys?: unknown[] } | null)?.keys;
  if (Array.isArray(keys) && keys.length > 0) return { jwksUri: `http://${kong}:8000/auth/v1/.well-known/jwks.json` };
  if (jwtSecret) return { jwtSecret };
  throw new Error("the project's Supabase Auth publishes no signing key and `supabase status` prints no JWT secret; run `supabase gen signing-key`, or pass --powersync <url>");
}

/** The project's JWKS, read through the API on this machine; null when there is none. */
export async function fetchJwks(api: string): Promise<unknown> {
  try {
    const res = await fetch(`${api.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
