import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI; resolves with its exit code and stderr. */
const cli = (args: string[], cwd?: string) =>
  new Promise<{ code: number | string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15_000, ...(cwd ? { cwd } : {}) }, (e, _stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : `killed (${e.signal}): timed out?`) : 0, stderr }),
    );
  });

describe("samesight exit codes", () => {
  it("exits 0 for help, and 2 when there is nothing it can run", { timeout: 30_000 }, async () => {
    expect((await cli(["--help"])).code).toBe(0);
    expect((await cli([])).code).toBe(2);
    const unknown = await cli(["frobnicate"]);
    expect([unknown.code, unknown.stderr]).toEqual([2, expect.stringMatching(/^Unknown command "frobnicate"/)]);
  });

  it("exits 2 when it cannot find the policy, or would write over one", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-cli-test-"));
    const missing = await cli(["check", "--policy", join(dir, "nowhere.policy.ts")]);
    expect([missing.code, missing.stderr]).toEqual([2, expect.stringMatching(/No policy file at/)]);
    writeFileSync(join(dir, "samesight.policy.ts"), "export default {};\n");
    const existing = await cli(["init", "--policy", join(dir, "samesight.policy.ts")]);
    expect([existing.code, existing.stderr]).toEqual([2, expect.stringMatching(/already exists/)]);
  });
});
