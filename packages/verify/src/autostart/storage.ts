/**
 * PowerSync's bucket storage for one audit run: a throwaway Postgres container on the
 * project's Supabase network, its data on a tmpfs so removing the container leaves no
 * volume behind. Its password is random and it publishes no port.
 */

import { randomBytes } from "node:crypto";
import type { Docker } from "./docker.ts";

/** The official image, pinned by digest; the same one the examples' compose files run. */
export const POSTGRES_IMAGE = "postgres:18.6@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6";

/** Every container auto-start runs carries this label, with the run's name as its value. */
export const RUN_LABEL = "dev.samesight.audit.run";

export const containerName = (run: string, part: "storage" | "powersync") => `samesight-audit-${run}-${part}`;

export interface Storage {
  container: string;
  /** The connection string PowerSync uses, by the container's name on the network. */
  uri: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the storage container and waits until it accepts connections over TCP. */
export async function startStorage(docker: Docker, run: string, network: string, timeoutMs = 60_000): Promise<Storage> {
  const container = containerName(run, "storage");
  const password = randomBytes(24).toString("hex");
  await docker.run([
    "run",
    "--detach",
    "--name",
    container,
    "--label",
    `${RUN_LABEL}=${run}`,
    "--network",
    network,
    "--tmpfs",
    "/var/lib/postgresql",
    "--env",
    "POSTGRES_DB=powersync_storage",
    "--env",
    "POSTGRES_USER=powersync_storage",
    // The value comes from docker's environment, so it never shows on a command line.
    "--env",
    "POSTGRES_PASSWORD",
    POSTGRES_IMAGE,
  ], { POSTGRES_PASSWORD: password });
  // Over TCP: the image's first-start server listens on its socket only, then restarts.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await docker.run(["exec", container, "pg_isready", "--quiet", "--host", "127.0.0.1", "--username", "powersync_storage", "--dbname", "powersync_storage"]);
      break;
    } catch (e) {
      if (Date.now() > deadline) {
        const logs = await docker.run(["logs", "--tail", "20", container]).catch(() => "");
        throw new Error(`the storage container ${container} did not start within ${timeoutMs / 1000}s${logs ? `:\n${logs}` : ` (${(e as Error).message})`}`);
      }
      await sleep(500);
    }
  }
  return { container, uri: `postgresql://powersync_storage:${password}@${container}:5432/powersync_storage` };
}

/** Removes containers and their anonymous volumes; ones already gone are no error. */
export async function removeContainers(docker: Docker, names: string[]): Promise<void> {
  if (!names.length) return;
  await docker.run(["rm", "--force", "--volumes", ...names]).catch((e: Error) => {
    if (!/no such container/i.test(e.message)) throw e;
  });
}
