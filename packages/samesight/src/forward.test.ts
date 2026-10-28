import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { besideShim, cmdLine, findVerify, forwardAudit, type Lookups, onPath, quoteForCmd } from "./forward.ts";

/** A package.json naming a samesight-verify script, and that script. */
function verifyPackage(dir: string, bin: string | Record<string, string> = { "samesight-verify": "./dist/cli.js" }): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist/cli.js"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@samesight/verify", bin }));
  return join(dir, "package.json");
}

const none: Lookups = { project: () => undefined, own: () => undefined, path: () => undefined };

/** Why a shim cmd.exe would expand part of the path of is not run. */
const refusal = (shim: string) =>
  `cannot run ${shim} safely through cmd.exe (its path holds % or !); install @samesight/verify in the project instead: npm install -D @samesight/verify`;

describe("findVerify", () => {
  const root = mkdtempSync(join(tmpdir(), "samesight-forward-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const project = verifyPackage(join(root, "project"));
  // A package with one script may name it with a string.
  const own = verifyPackage(join(root, "own"), "./dist/cli.js");

  it("takes the project's install first, then samesight's own, then the PATH", () => {
    const all: Lookups = { project: () => project, own: () => own, path: () => "/bin/samesight-verify" };
    expect(findVerify(all, "linux")).toEqual({ command: process.execPath, args: [join(root, "project/dist/cli.js")], shell: false });
    expect(findVerify({ ...all, project: () => undefined }, "linux")).toMatchObject({ args: [join(root, "own/dist/cli.js")] });
    expect(findVerify({ ...none, path: () => "/bin/samesight-verify" }, "linux")).toEqual({ command: "/bin/samesight-verify", args: [], shell: false });
    // A shim with no package beside it runs through cmd.exe.
    const shim = join(root, "nowhere/samesight-verify.cmd");
    expect(findVerify({ ...none, path: () => shim }, "win32")).toEqual({ command: shim, args: [], shell: true });
    expect(findVerify(none)).toBeUndefined();
  });

  it("passes over a package whose script is missing", () => {
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "package.json"), JSON.stringify({ bin: { "samesight-verify": "./gone.js" } }));
    expect(findVerify({ ...none, project: () => join(broken, "package.json"), own: () => own }, "linux")).toMatchObject({ args: [join(root, "own/dist/cli.js")] });
    expect(findVerify({ ...none, project: () => join(root, "nowhere/package.json") })).toBeUndefined();
  });

  // Split on ":" for linux, a Windows path (C:\...) would be cut at its drive.
  it.skipIf(process.platform === "win32")("finds samesight-verify, or samesight-verify.cmd on Windows, on the PATH", () => {
    const bin = posix.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(posix.join(bin, "samesight-verify"), "");
    writeFileSync(posix.join(bin, "samesight-verify.cmd"), "");
    expect(onPath({ PATH: `${posix.join(root, "empty")}:${bin}` }, "linux")).toBe(posix.join(bin, "samesight-verify"));
    expect(onPath({ Path: `${posix.join(root, "empty")};${bin}` }, "win32")).toBe(posix.join(bin, "samesight-verify.cmd"));
    expect(onPath({ PATH: "" }, "linux")).toBeUndefined();
  });

  it("runs the script beside a Windows shim with this Node, as npm installs globally", () => {
    // <prefix>/samesight-verify.cmd beside <prefix>/node_modules/@samesight/verify.
    const prefix = join(root, "prefix");
    verifyPackage(join(prefix, "node_modules/@samesight/verify"));
    const shim = join(prefix, "samesight-verify.cmd");
    writeFileSync(shim, "");
    expect(besideShim(shim)).toBe(join(prefix, "node_modules/@samesight/verify/package.json"));
    expect(besideShim(join(root, "own/samesight-verify.cmd"))).toBeUndefined();
    expect(findVerify({ ...none, path: () => shim }, "win32")).toEqual({
      command: process.execPath,
      args: [join(prefix, "node_modules/@samesight/verify/dist/cli.js")],
      shell: false,
    });
    // Elsewhere the command on the PATH runs as it is.
    expect(findVerify({ ...none, path: () => shim }, "linux")).toEqual({ command: shim, args: [], shell: false });
  });

  it("refuses to run a shim through cmd.exe when its path holds % or !", () => {
    for (const shim of [join(root, "100%/samesight-verify.cmd"), join(root, "%USERPROFILE%/samesight-verify.cmd"), join(root, "hi!/samesight-verify.cmd")]) {
      expect(findVerify({ ...none, path: () => shim }, "win32")).toBe(refusal(shim));
      expect(findVerify({ ...none, path: () => shim }, "linux")).toEqual({ command: shim, args: [], shell: false });
    }
    // With its package beside it, the shim's script runs without cmd.exe, whatever the path.
    const prefix = join(root, "50% off!");
    verifyPackage(join(prefix, "node_modules/@samesight/verify"));
    expect(findVerify({ ...none, path: () => join(prefix, "samesight-verify.cmd") }, "win32")).toEqual({
      command: process.execPath,
      args: [join(prefix, "node_modules/@samesight/verify/dist/cli.js")],
      shell: false,
    });
  });
});

describe("forwardAudit with a shim it will not run", () => {
  it("says why and exits 2, with a --json document, running nothing", async () => {
    const shim = "C:\\Users\\%USERNAME%\\npm\\samesight-verify.cmd";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let code: number;
    let printed: { out: string; err: string };
    try {
      code = await forwardAudit(["--json"], { ...none, path: () => shim }, "win32");
      printed = { out: stdout.mock.calls.map((c) => String(c[0])).join(""), err: stderr.mock.calls.map((c) => String(c[0])).join("") };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    expect(code).toBe(2);
    expect(printed.err).toBe(`samesight: ${refusal(shim)}\n`);
    expect(JSON.parse(printed.out)).toMatchObject({ tool: "samesight", mode: "audit", result: "incomplete", exitCode: 2, error: refusal(shim) });
  });
});

describe("quoteForCmd", () => {
  /** The argument before the carets: what the program's own parser is handed. */
  const unescaped = (a: string) => quoteForCmd(a).replace(/\^\^\^(.)/g, "$1");

  it("quotes every argument, and caret-escapes what cmd.exe acts on, twice for the shim", () => {
    expect(quoteForCmd("audit")).toBe('^^^"audit^^^"');
    expect(quoteForCmd("")).toBe('^^^"^^^"');
    expect(quoteForCmd("a b")).toBe('^^^"a^^^ b^^^"');
    expect(quoteForCmd("a&b|c<d>e^f%g!h")).toBe('^^^"a^^^&b^^^|c^^^<d^^^>e^^^^f^^^%g^^^!h^^^"');
    expect(unescaped("a&b|c<d>e^f%g!h")).toBe('"a&b|c<d>e^f%g!h"');
  });

  it("escapes quotes, and doubles the backslashes before one or at the end", () => {
    expect(unescaped('say "hi"')).toBe('"say \\"hi\\""');
    expect(unescaped("C:\\dir\\")).toBe('"C:\\dir\\\\"');
    expect(unescaped('a\\"b')).toBe('"a\\\\\\"b"');
    // Backslashes before anything else are left as they are.
    expect(unescaped("C:\\a\\b.yaml")).toBe('"C:\\a\\b.yaml"');
  });

  it("makes one command line of the shim and its arguments", () => {
    expect(cmdLine("C:\\Program Files (x86)\\npm\\samesight-verify.cmd", ["audit", "--json"])).toBe(
      '"C:\\Program Files (x86)\\npm\\samesight-verify.cmd" ^^^"audit^^^" ^^^"--json^^^"',
    );
  });
});

describe.skipIf(process.platform === "win32")("forwardAudit", () => {
  const dir = mkdtempSync(join(tmpdir(), "samesight-forward-run-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it("exits with the child's code, with audit and the arguments passed on", async () => {
    const out = join(dir, "args");
    const bin = script("exits", `echo "$@" > ${out}; exit 3`);
    expect(await forwardAudit(["--json", "--sync-config", "x.yaml"], { ...none, path: () => bin })).toBe(3);
    expect(readFileSync(out, "utf8")).toBe("audit --json --sync-config x.yaml\n");
  });

  it("exits 128 plus the signal's number when a signal ended the child", async () => {
    const bin = script("killed", "kill -TERM $$");
    expect(await forwardAudit([], { ...none, path: () => bin })).toBe(143);
  });
});

// The stub on the PATH is found only while samesight's own lookup finds no @samesight/verify:
// one hoisted to the repository's root node_modules would be run instead.
describe.skipIf(process.platform === "win32")("samesight audit stopped by a signal sent to it alone", () => {
  const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "samesight-forward-signal-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // A samesight-verify on the PATH that says which signal reached it, and ends as the signal
  // would; one the signal never reaches gives up after about 20s, rather than outlive the test.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const trap = (s: string) => `trap 'echo ${s} > "$OUT"; trap - ${s}; kill -${s} $$' ${s}`;
  const wait = "i=0\nwhile [ $i -lt 400 ]; do sleep 0.05; i=$((i + 1)); done\nexit 9";
  writeFileSync(join(bin, "samesight-verify"), `#!/bin/sh\n${["INT", "TERM", "HUP"].map(trap).join("\n")}\necho ready\n${wait}\n`);
  chmodSync(join(bin, "samesight-verify"), 0o755);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`passes ${signal} on to samesight-verify and exits as it did`, { timeout: 30_000 }, async ({ onTestFinished }) => {
      const out = join(dir, signal);
      // Not detached: the signal goes to samesight's pid only, never to a process group.
      const child = spawn(process.execPath, [CLI, "audit"], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
      onTestFinished(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      let printed = "";
      child.stderr.on("data", (d: Buffer) => {
        printed += d.toString();
      });
      const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d: Buffer) => {
          printed += d.toString();
          if (printed.includes("ready")) resolve();
        });
        child.on("exit", () => reject(new Error(`samesight exited before samesight-verify was ready:\n${printed}`)));
      });
      child.kill(signal);
      expect(await exit, printed).toBe(128 + constants.signals[signal]);
      expect(readFileSync(out, "utf8")).toBe(`${signal.slice(3)}\n`);
    });
  }
});
