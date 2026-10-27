import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { ensureImage, POWERSYNC_IMAGE, startPowerSync } from "./powersync.ts";
import { POSTGRES_IMAGE } from "./storage.ts";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A readiness probe on a local port, failing `notReady` times first. */
async function probe(notReady: number): Promise<number> {
  let left = notReady;
  server = createServer((req, res) => {
    res.statusCode = req.url === "/probes/readiness" && left-- <= 0 ? 200 : 503;
    res.end();
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

/** A fake docker that publishes `port` and keeps the container running while `running`. */
function fake(port: number, running = () => true) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: Exec = async (args, env) => {
    calls.push({ args, ...(env ? { env } : {}) });
    if (args[0] === "port") return { stdout: `127.0.0.1:${port}\n[::1]:${port}\n`, stderr: "" };
    if (args[0] === "container") return { stdout: JSON.stringify([{ State: { Running: running() } }]), stderr: "" };
    if (args[0] === "logs") return { stdout: "Error: could not connect to storage", stderr: "" };
    if (args[0] === "image") throw Object.assign(new Error("failed"), { stderr: `Error: No such image: ${args[2]}` });
    return { stdout: "", stderr: "" };
  };
  return { docker: new Docker(exec), calls };
}

describe("startPowerSync", () => {
  it("runs the pinned image on the network, its port on 127.0.0.1 only, and waits for readiness", async () => {
    const port = await probe(2);
    const { docker, calls } = fake(port);
    const ps = await startPowerSync(docker, { run: "a1b2c3d4", project: "todo", network: "supabase_network_todo", config: "port: 8080\n" });
    expect(ps).toEqual({ container: "samesight-audit-a1b2c3d4-powersync", url: `http://127.0.0.1:${port}` });
    const run = calls[0];
    expect(run?.args).toEqual([
      "run",
      "--detach",
      "--name",
      "samesight-audit-a1b2c3d4-powersync",
      "--label",
      "dev.samesight.audit.run=a1b2c3d4",
      "--label",
      "dev.samesight.audit.project=todo",
      "--network",
      "supabase_network_todo",
      "--publish",
      "127.0.0.1::8080",
      "--env",
      "POWERSYNC_CONFIG_B64",
      "--env",
      "NODE_OPTIONS=--max-old-space-size=1000",
      POWERSYNC_IMAGE,
      "start",
      "-r",
      "unified",
    ]);
    // The config, passwords and all, travels in docker's environment, not its arguments.
    expect(Buffer.from(run?.env?.POWERSYNC_CONFIG_B64 ?? "", "base64").toString()).toBe("port: 8080\n");
  });

  it("stops waiting when the container exits, with its last log lines", async () => {
    const port = await probe(Number.POSITIVE_INFINITY);
    const { docker } = fake(port, () => false);
    await expect(startPowerSync(docker, { run: "a1", project: "todo", network: "n", config: "" })).rejects.toThrow(/stopped while starting; its last log lines:\nError: could not connect to storage/);
  });

  it("gives up after the timeout", async () => {
    const port = await probe(Number.POSITIVE_INFINITY);
    const { docker } = fake(port);
    await expect(startPowerSync(docker, { run: "a1", project: "todo", network: "n", config: "", timeoutMs: 500 })).rejects.toThrow(/was not ready within 0.5s/);
  });
});

describe("startPowerSync with a replication check", () => {
  it("waits past readiness until the service replicates", async () => {
    const port = await probe(0);
    const { docker } = fake(port);
    let checks = 0;
    const ps = await startPowerSync(docker, { run: "a1", project: "todo", network: "n", config: "", pollMs: 5, replicating: async () => ++checks >= 3 });
    expect([ps.container, checks]).toEqual(["samesight-audit-a1-powersync", 3]);
  });

  it("names a service that was ready but stopped before it replicated, as one refusing its sync config does", async () => {
    const port = await probe(0);
    let inspected = 0;
    const { docker } = fake(port, () => ++inspected < 3);
    await expect(startPowerSync(docker, { run: "a1", project: "todo", network: "n", config: "", pollMs: 5, replicating: async () => false })).rejects.toThrow(
      /stopped before it began replicating \(it refuses a sync config it cannot use\); its last log lines:\nError: could not connect to storage/,
    );
  });

  it("gives up on a ready service that never replicates", async () => {
    const port = await probe(0);
    const { docker } = fake(port);
    await expect(startPowerSync(docker, { run: "a1", project: "todo", network: "n", config: "", timeoutMs: 50, pollMs: 5, replicating: async () => false })).rejects.toThrow(
      /did not begin replicating within 0.05s/,
    );
  });
});

describe("ensureImage", () => {
  it("pulls missing images once, naming PowerSync and its license", async () => {
    const lines: string[] = [];
    const pulls: string[][] = [];
    await ensureImage(fake(0).docker, (l) => lines.push(l), async (args) => {
      pulls.push(args);
    });
    expect(pulls).toEqual([
      ["pull", POWERSYNC_IMAGE],
      ["pull", POSTGRES_IMAGE],
    ]);
    expect(lines).toEqual([expect.stringMatching(/PowerSync service 1\.27\.2 .*FSL-1\.1-ALv2 license; run locally, never redistributed/), "pulling Postgres for the service's storage"]);
  });

  it("does nothing when the images are here", async () => {
    const here: Exec = async () => ({ stdout: JSON.stringify([{ Id: "sha256:d7a9" }]), stderr: "" });
    const pulls: string[][] = [];
    await ensureImage(new Docker(here), () => {}, async (args) => {
      pulls.push(args);
    });
    expect(pulls).toEqual([]);
  });
});
