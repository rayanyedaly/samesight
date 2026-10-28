import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOT_FOUND } from "./forward.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Runs the CLI; resolves with its exit code, stderr and stdout. */
const cli = (args: string[], cwd?: string, env?: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | string; stderr: string; stdout: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 15_000, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : `killed (${e.signal}): timed out?`) : 0, stderr, stdout }),
    );
  });

describe("samesight exit codes", () => {
  it("exits 0 for help, and 2 when there is nothing it can run", { timeout: 30_000 }, async () => {
    expect((await cli(["--help"])).code).toBe(0);
    expect((await cli([])).code).toBe(2);
    const unknown = await cli(["frobnicate"]);
    expect([unknown.code, unknown.stderr]).toEqual([2, 'samesight: unknown command "frobnicate"; the commands are init, generate, check, doctor, explain, lint, audit; see samesight --help\n']);
  });

  it("names a flag it cannot read in Node's words, and where to look", { timeout: 30_000 }, async () => {
    const flag = await cli(["check", "--frobnicate"]);
    expect([flag.code, flag.stderr]).toEqual([2, "samesight: unknown option '--frobnicate'; see samesight --help\n"]);
    const value = await cli(["explain", "--table"]);
    expect([value.code, value.stderr]).toEqual([2, "samesight: option '--table <value>' argument missing; see samesight --help\n"]);
  });

  it("says how to start a database it cannot reach", { timeout: 30_000 }, async () => {
    const policy = fileURLToPath(new URL("../../../examples/fieldbook/samesight.policy.ts", import.meta.url));
    const result = await cli(["generate", "--policy", policy, "--db", "postgresql://postgres:postgres@127.0.0.1:1/postgres"]);
    expect([result.code, result.stderr]).toEqual([2, "samesight: cannot reach the local database at 127.0.0.1:1; start it with supabase start (or pass --db)\n"]);
  });

  it("exits 2 when it cannot find the policy, or would write over one", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-cli-test-"));
    const missing = await cli(["check", "--policy", join(dir, "nowhere.policy.ts")]);
    expect([missing.code, missing.stderr]).toEqual([2, `samesight: no policy file at ${join(dir, "nowhere.policy.ts")}; run samesight init, or pass --policy\n`]);
    writeFileSync(join(dir, "samesight.policy.ts"), "export default {};\n");
    const existing = await cli(["init", "--policy", join(dir, "samesight.policy.ts")]);
    expect([existing.code, existing.stderr]).toEqual([2, `samesight: ${join(dir, "samesight.policy.ts")} already exists; edit it, or remove it to start again\n`]);
  });

  it("says to generate first when there is no schema snapshot, and exits 1 on a policy that does not compile", { timeout: 30_000 }, async () => {
    // Fieldbook's policy, from a directory of its own: no snapshot beside it.
    const dir = mkdtempSync(join(tmpdir(), "samesight-cli-test-"));
    const fieldbook = new URL("../../../examples/fieldbook/samesight.policy.ts", import.meta.url).href;
    writeFileSync(join(dir, "samesight.policy.mjs"), `export { default } from ${JSON.stringify(fieldbook)};\n`);
    const policy = ["--policy", join(dir, "samesight.policy.mjs")];
    for (const command of ["check", "explain"]) {
      const result = await cli([command, ...policy]);
      expect([result.code, result.stderr]).toEqual([2, `samesight: no schema snapshot at ${join(dir, "samesight/schema.json")}; run samesight generate first\n`]);
    }
    // A snapshot with none of the policy's tables.
    mkdirSync(join(dir, "samesight"));
    writeFileSync(join(dir, "samesight/schema.json"), JSON.stringify({ tables: [] }));
    const result = await cli(["explain", ...policy]);
    expect([result.code, result.stderr]).toEqual([1, expect.stringMatching(/^samesight: the policy does not compile:\n {2}- .*Membership/)]);
  });
});

describe("samesight audit", () => {
  // An example project that installs @samesight/verify.
  const project = fileURLToPath(new URL("../../../examples/audit-roles", import.meta.url));

  it("runs samesight-verify audit from the project's install, with its exit code", { timeout: 30_000 }, async () => {
    const help = await cli(["audit", "--help"], project);
    expect([help.code, help.stdout]).toEqual([0, expect.stringContaining("samesight-verify audit [audit options]")]);
    const missing = await cli(["audit", "--sync-config", "nowhere.yaml"], project);
    expect([missing.code, missing.stderr]).toEqual([2, expect.stringMatching(/no sync config at .*nowhere\.yaml/)]);
  });

  it("says how to install @samesight/verify when it finds none, and exits 2", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-cli-test-"));
    const result = await cli(["audit", "--help"], dir, { PATH: "" });
    expect([result.code, result.stderr, result.stdout]).toEqual([2, `${NOT_FOUND}\n`, ""]);
    // With --json, stdout still carries one document, as samesight-verify's would.
    const json = await cli(["audit", "--json"], dir, { PATH: "" });
    expect([json.code, json.stderr]).toEqual([2, `${NOT_FOUND}\n`]);
    expect(JSON.parse(json.stdout)).toEqual({
      tool: "samesight",
      version: 1,
      mode: "audit",
      result: "incomplete",
      exitCode: 2,
      durationMs: expect.any(Number),
      sections: [],
      error: NOT_FOUND.replace(/^samesight: /, ""),
    });
  });

  it("refuses audit after a flag, which would read audit's flags as samesight's", { timeout: 30_000 }, async () => {
    const message = "samesight: audit must come first, before any flag: samesight audit [audit options]; see samesight audit --help\n";
    for (const args of [["--policy", "x.ts", "audit"], ["--", "audit"], ["--sync-config", "x.yaml", "audit"], ["--db", "x", "audit", "--json"]]) {
      const result = await cli(args);
      expect([result.code, result.stderr]).toEqual([2, message]);
    }
    // An audit that is another command's argument is that command's business.
    const lint = await cli(["lint", "audit", "--bogus"]);
    expect([lint.code, lint.stderr]).toEqual([2, "samesight: unknown option '--bogus'; see samesight --help\n"]);
  });
});
