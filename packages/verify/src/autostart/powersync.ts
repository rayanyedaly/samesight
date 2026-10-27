/**
 * The PowerSync service for one audit run: the official image at a pinned version, on the
 * project's Supabase network (never reaching the database through host ports, which
 * Docker Desktop routes differently), with its HTTP port published on 127.0.0.1 only, at
 * a port Docker picks. The image is FSL-licensed: it is pulled from Docker Hub and run
 * here, never bundled or redistributed.
 */

import { type Docker, streamDocker } from "./docker.ts";
import { containerName, labels, POSTGRES_IMAGE } from "./storage.ts";

/** Pinned by digest; the version the examples' compose files run. Above the security floor (1.20.1). */
export const POWERSYNC_VERSION = "1.27.2";
export const POWERSYNC_IMAGE = "journeyapps/powersync-service@sha256:d7a99817057a42dae9e6d8fe0c70b49d99105dcac8b8ab0e9ed3cf1ff0978b8b";

/** Pulls the service's image and its storage's, with Docker's progress on stderr, unless they are here. */
export async function ensureImage(docker: Docker, log: (line: string) => void, pull: (args: string[]) => Promise<void> = streamDocker): Promise<void> {
  if (!(await docker.inspect("image", POWERSYNC_IMAGE))) {
    log(`pulling the PowerSync service ${POWERSYNC_VERSION} (journeyapps/powersync-service, FSL-1.1-ALv2 license; run locally, never redistributed)`);
    await pull(["pull", POWERSYNC_IMAGE]);
  }
  if (!(await docker.inspect("image", POSTGRES_IMAGE))) {
    log("pulling Postgres for the service's storage");
    await pull(["pull", POSTGRES_IMAGE]);
  }
}

export interface PowerSync {
  container: string;
  /** The service on this machine. */
  url: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The service's address on this machine, from the port Docker published. */
export async function serviceUrl(docker: Docker, container: string): Promise<string> {
  const address = (await docker.run(["port", container, "8080/tcp"])).split(/\r?\n/).find((l) => l.startsWith("127.0.0.1:"));
  if (!address) throw new Error(`docker published no 127.0.0.1 port for ${container}`);
  return `http://${address}`;
}

export const isReady = (url: string) =>
  fetch(`${url}/probes/readiness`, { signal: AbortSignal.timeout(2000) }).then(
    (r) => r.ok,
    () => false,
  );

/** Starts the service with this config and waits for its readiness probe, or until `aborted`. */
export async function startPowerSync(
  docker: Docker,
  o: { run: string; project: string; network: string; config: string; labels?: string[]; timeoutMs?: number; aborted?: () => boolean },
): Promise<PowerSync> {
  const container = containerName(o.run, "powersync");
  await docker.run(
    [
      "run",
      "--detach",
      "--name",
      container,
      ...labels(o.run, o.project),
      ...(o.labels ?? []).flatMap((l) => ["--label", l]),
      "--network",
      o.network,
      "--publish",
      "127.0.0.1::8080",
      // The config holds the run's passwords: it comes from docker's environment.
      "--env",
      "POWERSYNC_CONFIG_B64",
      "--env",
      "NODE_OPTIONS=--max-old-space-size=1000",
      POWERSYNC_IMAGE,
      "start",
      "-r",
      "unified",
    ],
    { POWERSYNC_CONFIG_B64: Buffer.from(o.config).toString("base64") },
  );
  const url = await serviceUrl(docker, container);

  const timeoutMs = o.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const failure = async (why: string) => {
    const logs = await docker.logs(container, 30).catch(() => "");
    return new Error(`the PowerSync service ${why}${logs ? `; its last log lines:\n${logs}` : ""}`);
  };
  for (;;) {
    if (await isReady(url)) return { container, url };
    if (o.aborted?.()) throw new Error("stopped while PowerSync started");
    const state = await docker.inspect<{ State: { Running: boolean } }>("container", container);
    if (!state?.State.Running) throw await failure("stopped while starting");
    if (Date.now() > deadline) throw await failure(`was not ready within ${timeoutMs / 1000}s`);
    await sleep(1000);
  }
}
