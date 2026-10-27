/**
 * Auto-start: what `samesight-verify audit` does when no --powersync is given. Once the
 * sync config and the database catalog have passed (so the project's "powersync"
 * publication is there), it runs a PowerSync service of its own beside the project's
 * local Supabase stack, for this run only, and removes everything it made when the run
 * ends (see Teardown and sweep):
 *
 *   1. finds the project's Supabase containers and network (project.ts);
 *   2. takes a lock on the database, held until the run ends, so two audits never share it;
 *   3. removes what a killed earlier run left (sweep.ts);
 *   4. creates a replication role (replication.ts);
 *   5. starts a throwaway storage Postgres (storage.ts);
 *   6. writes the service config, by JWKS or shared secret (config.ts);
 *   7. starts the pinned PowerSync image and waits until it is ready (powersync.ts).
 *
 * It works on a connection of its own, never the audit's: a Ctrl+C mid-audit would
 * otherwise run the teardown inside the audit's open transaction, as its role.
 *
 * With `keep`, the service and all it uses stay up after the run, labelled with a
 * fingerprint of what it serves (image, sync config, tables, token check). The next run
 * on the project reuses it when the fingerprint matches and its role and replication are
 * still there, and otherwise sweeps it and starts afresh; a run without `keep` that
 * reuses it removes it at the end.
 */

import { createHash, randomBytes } from "node:crypto";
import { parse } from "yaml";
import type pg from "pg";
import { chooseAuth, fetchJwks, serviceConfig } from "./config.ts";
import { Docker } from "./docker.ts";
import { ensureImage, isReady, POWERSYNC_IMAGE, POWERSYNC_VERSION, serviceUrl, startPowerSync } from "./powersync.ts";
import { findSupabase } from "./project.ts";
import { PREFIX, runName, setUpReplication, tearDownReplication } from "./replication.ts";
import { containerName, PROJECT_LABEL, RUN_LABEL, removeContainers, startStorage } from "./storage.ts";
import { sweep } from "./sweep.ts";
import { onSignals, type Signals, Teardown } from "./teardown.ts";

type Client = Pick<pg.Client, "query" | "escapeIdentifier" | "escapeLiteral">;

export interface AutoStartOptions {
  /** The directory holding supabase/. */
  projectDir: string;
  /**
   * A connection of auto-start's own to the project's local database, as the user
   * `supabase status` names; not the one the audit runs on. The caller closes it after stop.
   */
  client: Client;
  /** The port on this machine that connection reaches the database at. */
  dbPort: number;
  /** The Supabase API on this machine. */
  api: string;
  jwtSecret?: string;
  /** The sync config under audit, as text. */
  syncConfig: string;
  /** The public tables PowerSync must read: the synced ones and those their queries read. */
  tables: string[];
  log: (line: string) => void;
  /** Leave the service up when the run ends, for the next run to reuse. */
  keep?: boolean;
  docker?: Docker;
  /** For tests: where signals come from. */
  proc?: Signals;
}

/** On a kept service's containers: the fingerprint of what it serves. */
export const KEEP_LABEL = "dev.samesight.audit.keep";

/** Held by a run from before its sweep until it ends; a constant no other tool uses. */
const LOCK = 7_350_871_002;

export interface AutoStarted {
  /** The service on this machine. */
  url: string;
  version: string;
  /** The start of this run's replication slot names. */
  slotPrefix: string;
  /** A service an earlier run kept, rather than one this run started. */
  reused: boolean;
  /**
   * Removes everything this run started (unless kept); resolves with what could not be
   * removed. With `logs`, first hands it the service's last log lines.
   */
  stop: (o?: { logs?: (text: string) => void }) => Promise<string[]>;
}

export async function autoStart(o: AutoStartOptions): Promise<AutoStarted> {
  const docker = o.docker ?? new Docker();
  await docker.check();
  const supabase = await findSupabase(docker, o.projectDir, o.dbPort);
  // The database PowerSync will replicate from must be the one the audit connects to, not one on another Docker host.
  const { rows: here } = await o.client.query<{ id: string }>("select system_identifier::text as id from pg_control_system()");
  const there = await docker.run(["exec", supabase.db, "psql", "-tA", "-U", "postgres", "-c", "select system_identifier from pg_control_system()"]);
  if (!here[0] || here[0].id !== there) throw new Error(`${supabase.db} is not the database the audit connects to; is Docker (DOCKER_HOST, docker context) another machine's?`);
  const auth = chooseAuth(await fetchJwks(o.api), supabase.kong, o.jwtSecret);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ image: POWERSYNC_IMAGE, syncConfig: o.syncConfig, tables: [...o.tables].sort(), auth }))
    .digest("hex")
    .slice(0, 16);

  const { rows: lock } = await o.client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [LOCK]);
  if (!lock[0]?.ok) throw new Error("another samesight-verify audit is running PowerSync on this database; wait for it to end");
  const unlock = () => o.client.query("select pg_advisory_unlock($1)", [LOCK]).then(() => {});

  // The run's secrets, kept out of the errors and log lines it prints.
  const secrets = o.jwtSecret ? [o.jwtSecret] : [];
  const redact = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, "***"), text);
  const log = (line: string) => o.log(redact(line));
  const teardown = new Teardown(log);
  // Closing the connection releases it too, so this step never fails.
  teardown.add("the audit's lock on the database", () => unlock().catch(() => {}));
  const stopListening = onSignals(teardown, log, o.proc);
  const logsOf = async (container: string, logs?: (text: string) => void) => {
    if (logs) logs(redact(await docker.logs(container, 50).catch((e: Error) => `(no logs: ${e.message})`)));
  };
  /** Ends the run: tears down, or with `keep` only lets go of the lock. */
  const stopper =
    (container: string, keep: boolean, url: string): AutoStarted["stop"] =>
    async ({ logs } = {}) => {
      await logsOf(container, logs);
      if (!keep) {
        const failed = await teardown.run();
        stopListening();
        return failed;
      }
      stopListening();
      await unlock().catch(() => {});
      log(`kept the PowerSync service at ${url}; the next audit of this project that starts PowerSync reuses it if nothing changed and otherwise replaces it, and removes it at its end unless given --keep-powersync`);
      return [];
    };

  try {
    const kept = await keptRun(docker, o.client, supabase.project, fingerprint, o.tables);
    if (kept) {
      log(`reusing the PowerSync service an earlier run kept (${kept.run}) at ${kept.url}`);
      secrets.push(...kept.secrets);
      const role = `${PREFIX}${kept.run}`;
      teardown.add(`role ${role} and its replication slots`, () => tearDownReplication(o.client, { role, slotPrefix: `${role}_` }));
      const containers = [containerName(kept.run, "storage"), containerName(kept.run, "powersync")];
      teardown.add(`containers ${containers.join(", ")}`, () => removeContainers(docker, containers));
      if (o.keep) stopListening();
      const stop = stopper(containerName(kept.run, "powersync"), o.keep === true, kept.url);
      return { url: kept.url, version: POWERSYNC_VERSION, slotPrefix: `${role}_`, reused: true, stop };
    }

    // Each step that makes or removes something runs through teardown.step, so Ctrl+C
    // mid-start waits for it, and nothing is made after the teardown has run.
    const leftovers = await teardown.step(() => sweep(docker, o.client, supabase.project, log));
    if (leftovers.length) log(`removed what an earlier run left: ${leftovers.join(", ")}`);
    // Pulled before anything is created, so a failed pull leaves nothing to remove.
    if (teardown.started) throw new Error("stopped");
    await ensureImage(docker, log);

    const run = runName();
    // Each step is added before what it removes is made: a run failing half way removes what it made.
    const role = `${PREFIX}${run}`;
    teardown.add(`role ${role} and its replication slots`, () => tearDownReplication(o.client, { role, slotPrefix: `${role}_` }));
    const containers = [containerName(run, "storage"), containerName(run, "powersync")];
    teardown.add(`containers ${containers.join(", ")}`, () => removeContainers(docker, containers));
    log(`starting PowerSync ${POWERSYNC_VERSION} for this run (${run}) on ${supabase.network}`);
    const replication = await teardown.step(() => setUpReplication(o.client, run, o.tables));
    secrets.push(replication.password);
    const storagePassword = randomBytes(24).toString("hex");
    secrets.push(storagePassword);
    const storage = await teardown.step(() => startStorage(docker, run, supabase.project, supabase.network, undefined, () => teardown.started, storagePassword));
    const config = serviceConfig({
      dataSource: `postgresql://${replication.role}:${replication.password}@${supabase.db}:5432/postgres`,
      storage: storage.uri,
      slotPrefix: replication.slotPrefix,
      syncConfig: o.syncConfig,
      auth,
    });
    const powersync = await teardown.step(() =>
      startPowerSync(docker, {
        run,
        project: supabase.project,
        network: supabase.network,
        config,
        ...(o.keep ? { labels: [`${KEEP_LABEL}=${fingerprint}`] } : {}),
        aborted: () => teardown.started,
      }),
    );
    log(`PowerSync is ready at ${powersync.url} (tokens checked ${"jwksUri" in auth ? "against the project's JWKS" : "with its shared secret"})`);
    // Kept from here on: Ctrl+C no longer removes it.
    if (o.keep) stopListening();
    return { url: powersync.url, version: POWERSYNC_VERSION, slotPrefix: replication.slotPrefix, reused: false, stop: stopper(powersync.container, o.keep === true, powersync.url) };
  } catch (e) {
    await teardown.run();
    stopListening();
    if (e instanceof Error) {
      e.message = redact(e.message);
      if (e.stack) e.stack = redact(e.stack);
    }
    throw e;
  }
}

/**
 * Whether a kept run's role ($1) exists, an active slot of it ($2, its prefix) is up, and
 * the role can read every table ($3). The privilege check runs only once the role is
 * known to exist: it fails on a missing one.
 */
export const KEPT_ALIVE = `select case when exists (select from pg_roles where rolname = $1)
                     and exists (select from pg_replication_slots where active and starts_with(slot_name, $2))
                then coalesce((select bool_and(has_table_privilege($1, format('public.%I', t), 'select')) from unnest($3::text[]) t), true)
                else false end as ok`;

/**
 * A kept service of this project serving the same fingerprint, running and ready, whose
 * role and replication slot are still in the database (a reset database has neither) and
 * whose role can still read the tables (a recreated table has lost its grant); null
 * otherwise, and the sweep removes it.
 */
async function keptRun(
  docker: Docker,
  client: Client,
  project: string,
  fingerprint: string,
  tables: string[],
): Promise<{ run: string; url: string; secrets: string[] } | null> {
  const [name] = await docker.containers([`label=${PROJECT_LABEL}=${project}`, `label=${KEEP_LABEL}=${fingerprint}`, "status=running"]);
  if (!name) return null;
  const info = await docker.inspect<{ Config: { Labels: Record<string, string> | null; Env?: string[] | null } }>("container", name);
  const run = info?.Config.Labels?.[RUN_LABEL];
  if (!run || !/^[0-9a-f]+$/.test(run)) return null;
  // Its storage must still be up too.
  if (!(await docker.containers([`name=^${containerName(run, "storage")}$`, "status=running"])).length) return null;
  const { rows } = await client.query<{ ok: boolean }>(KEPT_ALIVE, [`${PREFIX}${run}`, `${PREFIX}${run}_`, tables]);
  if (!rows[0]?.ok) return null;
  const url = await serviceUrl(docker, name).catch(() => null);
  if (!url || !(await isReady(url))) return null;
  // Without both its passwords (replication, storage), what it prints could not be masked: started afresh instead.
  const secrets = keptSecrets(info?.Config.Env ?? []);
  return secrets.length >= 2 ? { run, url, secrets } : null;
}

/** A kept service's passwords, from the config it was given, to keep out of what this run prints. */
function keptSecrets(env: string[]): string[] {
  const b64 = env.find((e) => e.startsWith("POWERSYNC_CONFIG_B64="))?.slice("POWERSYNC_CONFIG_B64=".length) ?? "";
  let config: { replication?: { connections?: unknown }; storage?: { uri?: unknown } } | null;
  try {
    config = parse(Buffer.from(b64, "base64").toString(), { customTags: [{ tag: "!env", resolve: (v: string) => v }] });
  } catch {
    return [];
  }
  const connections = Array.isArray(config?.replication?.connections) ? (config.replication.connections as { uri?: unknown }[]) : [];
  return [...connections.map((c) => c?.uri), config?.storage?.uri].flatMap((u) => {
    try {
      const password = typeof u === "string" ? decodeURIComponent(new URL(u).password) : "";
      return password ? [password] : [];
    } catch {
      return [];
    }
  });
}
