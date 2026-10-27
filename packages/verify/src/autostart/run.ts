/**
 * Auto-start: what `samesight-verify audit` does when no --powersync is given. It runs a
 * PowerSync service of its own beside the project's local Supabase stack, for this run
 * only, and removes everything it made when the run ends (see Teardown and sweep):
 *
 *   1. finds the project's Supabase containers and network (project.ts);
 *   2. removes what a killed earlier run left (sweep.ts);
 *   3. creates a replication role, and the "powersync" publication if there is none (replication.ts);
 *   4. starts a throwaway storage Postgres (storage.ts);
 *   5. writes the service config, by JWKS or shared secret (config.ts);
 *   6. starts the pinned PowerSync image and waits until it is ready (powersync.ts).
 *
 * With `keep`, the service and all it uses stay up after the run, labelled with a
 * fingerprint of what it serves (image, sync config, tables, token check). The next run
 * on the project reuses it when the fingerprint matches, and otherwise sweeps it and
 * starts afresh; a run without `keep` that reuses it removes it at the end.
 *
 * Two audits of the same project at once are not supported: they would share the
 * publication, and each one's sweep could remove the other's containers.
 */

import { createHash } from "node:crypto";
import type pg from "pg";
import { chooseAuth, fetchJwks, serviceConfig } from "./config.ts";
import { Docker } from "./docker.ts";
import { ensureImage, isReady, POWERSYNC_IMAGE, POWERSYNC_VERSION, serviceUrl, startPowerSync } from "./powersync.ts";
import { findSupabase } from "./project.ts";
import { PREFIX, runName, setUpReplication, tearDownReplication } from "./replication.ts";
import { containerName, PROJECT_LABEL, RUN_LABEL, removeContainers, startStorage } from "./storage.ts";
import { sweep } from "./sweep.ts";
import { onSignals, Teardown } from "./teardown.ts";

export interface AutoStartOptions {
  /** The directory holding supabase/. */
  projectDir: string;
  /** Connected to the project's local database, as the user `supabase status` names. */
  client: pg.Client;
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
}

/** On a kept service's containers: the fingerprint of what it serves. */
export const KEEP_LABEL = "dev.samesight.audit.keep";

export interface AutoStarted {
  /** The service on this machine. */
  url: string;
  version: string;
  /** The start of this run's replication slot names. */
  slotPrefix: string;
  /** Removes everything this run started; resolves with what could not be removed. */
  stop: () => Promise<string[]>;
}

export async function autoStart(o: AutoStartOptions): Promise<AutoStarted> {
  const docker = o.docker ?? new Docker();
  await docker.check();
  const supabase = await findSupabase(docker, o.projectDir);
  const auth = chooseAuth(await fetchJwks(o.api), supabase.kong, o.jwtSecret);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ image: POWERSYNC_IMAGE, syncConfig: o.syncConfig, tables: [...o.tables].sort(), auth }))
    .digest("hex")
    .slice(0, 16);

  const kept = await keptRun(docker, supabase.project, fingerprint);
  if (kept) {
    o.log(`reusing the PowerSync service an earlier run kept (${kept.run}) at ${kept.url}`);
    const teardown = new Teardown(o.log);
    const role = `${PREFIX}${kept.run}`;
    teardown.add(`role ${role}, its replication slots and publication`, () =>
      tearDownReplication(o.client, { run: kept.run, role, slotPrefix: `${role}_`, createdPublication: true }),
    );
    const containers = [containerName(kept.run, "storage"), containerName(kept.run, "powersync")];
    teardown.add(`containers ${containers.join(", ")}`, () => removeContainers(docker, containers));
    if (o.keep) return { url: kept.url, version: POWERSYNC_VERSION, slotPrefix: `${role}_`, stop: async () => [] };
    // Not kept this time: removed at the end, or on Ctrl+C, like a service this run started.
    const stopListening = onSignals(teardown, o.log);
    const stop = async () => {
      const failed = await teardown.run();
      stopListening();
      return failed;
    };
    return { url: kept.url, version: POWERSYNC_VERSION, slotPrefix: `${role}_`, stop };
  }

  const leftovers = await sweep(docker, o.client, supabase.project);
  if (leftovers.length) o.log(`removed what an earlier run left: ${leftovers.join(", ")}`);
  // Pulled before anything is created, so a failed pull leaves nothing to remove.
  await ensureImage(docker, o.log);

  const run = runName();
  const teardown = new Teardown(o.log);
  const stopListening = onSignals(teardown, o.log);
  const stop = async () => {
    const failed = await teardown.run();
    stopListening();
    return failed;
  };
  // Each step is added before what it removes is made: a run failing half way removes what it made.
  const role = `${PREFIX}${run}`;
  let createdPublication = true;
  teardown.add(`role ${role}, its replication slots and publication`, () => tearDownReplication(o.client, { run, role, slotPrefix: `${role}_`, createdPublication }));
  const containers = [containerName(run, "storage"), containerName(run, "powersync")];
  teardown.add(`containers ${containers.join(", ")}`, () => removeContainers(docker, containers));
  try {
    o.log(`starting PowerSync ${POWERSYNC_VERSION} for this run (${run}) on ${supabase.network}`);
    const replication = await setUpReplication(o.client, run, o.tables);
    createdPublication = replication.createdPublication;
    if (createdPublication) o.log(`the project has no "powersync" publication; created one for this run: ${o.tables.join(", ")}`);
    const storage = await startStorage(docker, run, supabase.project, supabase.network);
    const config = serviceConfig({
      dataSource: `postgresql://${replication.role}:${replication.password}@${supabase.db}:5432/postgres`,
      storage: storage.uri,
      slotPrefix: replication.slotPrefix,
      syncConfig: o.syncConfig,
      auth,
    });
    const powersync = await startPowerSync(docker, {
      run,
      project: supabase.project,
      network: supabase.network,
      config,
      ...(o.keep ? { labels: [`${KEEP_LABEL}=${fingerprint}`] } : {}),
    });
    o.log(`PowerSync is ready at ${powersync.url} (tokens checked ${"jwksUri" in auth ? "against the project's JWKS" : "with its shared secret"})`);
    if (o.keep) {
      // Kept from here on: Ctrl+C no longer removes it.
      stopListening();
      const kept = async () => {
        o.log(`kept the PowerSync service at ${powersync.url}; the next audit of this project reuses it, or removes it if the sync config changed`);
        return [];
      };
      return { url: powersync.url, version: POWERSYNC_VERSION, slotPrefix: replication.slotPrefix, stop: kept };
    }
    return { url: powersync.url, version: POWERSYNC_VERSION, slotPrefix: replication.slotPrefix, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** A kept service of this project serving the same fingerprint, running and ready; null otherwise. */
async function keptRun(docker: Docker, project: string, fingerprint: string): Promise<{ run: string; url: string } | null> {
  const [name] = await docker.containers([`label=${PROJECT_LABEL}=${project}`, `label=${KEEP_LABEL}=${fingerprint}`, "status=running"]);
  if (!name) return null;
  const info = await docker.inspect<{ Config: { Labels: Record<string, string> | null } }>("container", name);
  const run = info?.Config.Labels?.[RUN_LABEL];
  if (!run) return null;
  // Its storage must still be up too.
  if (!(await docker.containers([`name=^${containerName(run, "storage")}$`, "status=running"])).length) return null;
  const url = await serviceUrl(docker, name).catch(() => null);
  return url && (await isReady(url)) ? { run, url } : null;
}
