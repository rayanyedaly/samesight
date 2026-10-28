/**
 * The verifier creates users, writes rows and restarts the PowerSync service, so it
 * refuses to run anywhere but a developer machine or CI: every URL it is given must
 * point at this machine, and nothing may look like a deployed environment.
 *
 * A port forwarded to a remote database (ssh -L, kubectl port-forward) looks local; the
 * guard cannot tell, so do not run the verifier through one.
 */

import { assertLocal } from "samesight/compiler";

/** The hosts the Supabase CLI and a local PowerSync container listen on. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Variables a hosting platform sets and a laptop or CI runner does not. */
export const DEPLOYED = [
  "VERCEL",
  "VERCEL_ENV",
  "NETLIFY",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_PROJECT_ID",
  "FLY_APP_NAME",
  "RENDER",
  "RENDER_SERVICE_ID",
  "HEROKU_APP_ID",
  "DYNO",
  "K_SERVICE",
  "GAE_APPLICATION",
  "AWS_EXECUTION_ENV",
  "ECS_CONTAINER_METADATA_URI",
  "KUBERNETES_SERVICE_HOST",
];

export interface Targets {
  /** Postgres, e.g. the Supabase CLI's postgresql://postgres:postgres@127.0.0.1:54322/postgres. */
  db: string;
  /** HTTP services: the Supabase API (Auth, REST) and the PowerSync service. */
  http: Record<string, string>;
  /** The flag that sets an HTTP service, by name, for the fix a refusal names; one without is read from supabase status. */
  flags?: Record<string, string>;
}

/** The fix for an address read from supabase status, which only a stack on this machine changes. */
const FROM_STATUS = "it comes from supabase status: run the project's local stack on this machine (supabase start)";

/**
 * A value as a refusal may print it: everything up to its last @, and any query or
 * fragment, left out, since a value pasted from elsewhere can carry a password or a token.
 */
export function shown(value: string): string {
  return value.replace(/^[\s\S]*@/, "…@").replace(/[?#][\s\S]*$/, "…");
}

/** Throws, listing every problem, unless each target is local and the environment is not a deployment. */
export function assertLocalTargets(targets: Targets, env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];
  try {
    assertLocal(targets.db);
  } catch (e) {
    problems.push(`database: ${(e as Error).message}; ${FROM_STATUS}`);
  }
  for (const [name, url] of Object.entries(targets.http)) {
    const flag = targets.flags?.[name];
    const toUrl = flag ? `pass ${flag} an http(s) URL on localhost or 127.0.0.1` : FROM_STATUS;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      problems.push(`${name}: "${shown(url)}" is not a URL; ${toUrl}`);
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") problems.push(`${name}: "${shown(url)}" is not an http(s) URL; ${toUrl}`);
    else if (!LOCAL_HOSTS.has(parsed.hostname)) {
      problems.push(`${name}: ${parsed.hostname} is not this machine; ${flag ? `point ${flag} at localhost or 127.0.0.1` : FROM_STATUS}`);
    }
  }
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    problems.push(`NODE_ENV is "${nodeEnv}"; the verifier runs only in development or test: unset NODE_ENV, or set it to development or test`);
  }
  for (const name of DEPLOYED) if (env[name]) problems.push(`${name} is set, so this looks like a deployment; run it on a developer machine or in CI`);

  if (problems.length) {
    throw new Error(
      `refuses to run:\n  - ${problems.join("\n  - ")}\n` +
        "It creates users, writes rows, restarts PowerSync and (audit) starts containers and a replication role, so it only runs against a local stack.",
    );
  }
}
