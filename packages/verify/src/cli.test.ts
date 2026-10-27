import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI; resolves with its exit code and stderr. */
const cli = (args: string[]) =>
  new Promise<{ code: number | string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15_000 }, (e, _stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : `killed (${e.signal}): timed out?`) : 0, stderr }),
    );
  });

describe("samesight-verify audit flags", () => {
  it.each([
    [["--keep-powersync", "--powersync", "http://127.0.0.1:8080"], /--keep-powersync keeps the service audit starts/],
    [["--keep-powersync", "--static"], /--keep-powersync .* --powersync or --static/],
    [["--compose", "docker-compose.yml"], /--compose checks the version of a PowerSync service you run yourself; pass it with --powersync or --static/],
    [["--publication", "mine"], /replicates the "powersync" publication; --publication mine needs --powersync or --static/],
  ])(
    "refuses %j before touching anything",
    async (args, message) => {
      const { code, stderr } = await cli(["audit", ...args]);
      // Could not run: 2, not the 1 of a finding.
      expect(code).toBe(2);
      expect(stderr).toMatch(message);
    },
    20_000,
  );

  it("takes --compose with --static", { timeout: 20_000 }, async () => {
    const { code, stderr } = await cli(["audit", "--static", "--compose", "docker-compose.yml", "--sync-config", "nowhere.yaml"]);
    expect(stderr).not.toMatch(/--compose checks/);
    expect(stderr).toMatch(/No sync config at/);
    expect(code).toBe(2);
  });

  it("exits 2 on a flag it cannot read, and on a policy it cannot find", { timeout: 20_000 }, async () => {
    expect((await cli(["audit", "--runs", "many"])).code).toBe(2);
    expect((await cli(["--policy", "nowhere.policy.ts"])).code).toBe(2);
  });

  it.each([["stdout"], ["stderr"], ["stdout", "stderr"]])(
    "exits 141 when its %s has gone",
    async (...closed) => {
      for (const args of [["--help"], ["audit", "--static", "--sync-config", "nowhere.yaml"]]) {
        const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        for (const name of closed) child[name as "stdout" | "stderr"].destroy();
        const code = await new Promise<number | null>((r) => child.on("close", r));
        expect(code, args.join(" ")).toBe(141);
      }
    },
    20_000,
  );
});
