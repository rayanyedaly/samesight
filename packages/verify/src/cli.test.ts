import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI; resolves with its exit code, stdout and stderr. */
const cli = (args: string[]) =>
  new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15_000 }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : `killed (${e.signal}): timed out?`) : 0, stdout, stderr }),
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
    expect(stderr).toMatch(/no sync config at/);
    expect(code).toBe(2);
  });

  it("exits 2 on a flag it cannot read, and on a policy it cannot find", { timeout: 20_000 }, async () => {
    expect((await cli(["audit", "--runs", "many"])).code).toBe(2);
    expect((await cli(["--policy", "nowhere.policy.ts"])).code).toBe(2);
  });

  it("with --json, writes one document to stdout on exit 2, the message on stderr too", { timeout: 20_000 }, async () => {
    for (const [args, mode, error] of [
      [["audit", "--runs", "many", "--json"], "audit", /--runs must be a whole number/],
      [["--json", "--bogus"], "policy", /Unknown option '--bogus'/],
      [["audit", "--json", "--seed", "3", "--sync-config", "nowhere.yaml"], "audit", /no sync config at .*nowhere\.yaml/],
    ] as const) {
      const { code, stdout, stderr } = await cli([...args]);
      expect(code, args.join(" ")).toBe(2);
      const doc = JSON.parse(stdout);
      expect(doc).toMatchObject({ version: 1, tool: "samesight-verify", mode, result: "incomplete", exitCode: 2, sections: [] });
      expect(doc.error).toMatch(error);
      expect(stderr).toMatch(error);
    }
    // The help, a pass, goes to stderr, and the document says it passed.
    const help = await cli(["--help", "--json"]);
    expect(help.stderr).toMatch(/Usage: samesight-verify/);
    expect(JSON.parse(help.stdout)).toMatchObject({ result: "passed", exitCode: 0 });
  });

  it("writes --report on exit 2 too, with the error, and none for --help", { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-report-"));
    try {
      expect((await cli(["audit", "--runs", "many", "--report", join(dir, "flag.md")])).code).toBe(2);
      expect(readFileSync(join(dir, "flag.md"), "utf8")).toMatch(/^# samesight-verify: COULD NOT RUN \(audit\)\n\nExit code 2\.\n\n## Error\n\n```\n--runs must be a whole number/);
      expect((await cli(["audit", `--report=${join(dir, "sync.md")}`, "--sync-config", "nowhere.yaml"])).code).toBe(2);
      expect(readFileSync(join(dir, "sync.md"), "utf8")).toMatch(/no sync config at .*nowhere\.yaml/);
      expect((await cli(["--help", "--report", join(dir, "help.md")])).code).toBe(0);
      expect(existsSync(join(dir, "help.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
