import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findVerify, forwardAudit, type Lookups, onPath } from "./forward.ts";

/** A package.json naming a samesight-verify script, and that script. */
function verifyPackage(dir: string, bin: string | Record<string, string> = { "samesight-verify": "./dist/cli.js" }): string {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist/cli.js"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@samesight/verify", bin }));
  return join(dir, "package.json");
}

const none: Lookups = { project: () => undefined, own: () => undefined, path: () => undefined };

describe("findVerify", () => {
  const root = mkdtempSync(join(tmpdir(), "samesight-forward-"));
  const project = verifyPackage(join(root, "project"));
  // A package with one script may name it with a string.
  const own = verifyPackage(join(root, "own"), "./dist/cli.js");

  it("takes the project's install first, then samesight's own, then the PATH", () => {
    const all: Lookups = { project: () => project, own: () => own, path: () => "/bin/samesight-verify" };
    expect(findVerify(all, "linux")).toEqual({ command: process.execPath, args: [join(root, "project/dist/cli.js")], shell: false });
    expect(findVerify({ ...all, project: () => undefined }, "linux")?.args).toEqual([join(root, "own/dist/cli.js")]);
    expect(findVerify({ ...none, path: () => "/bin/samesight-verify" }, "linux")).toEqual({ command: "/bin/samesight-verify", args: [], shell: false });
    expect(findVerify({ ...none, path: () => "C:\\bin\\samesight-verify.cmd" }, "win32")?.shell).toBe(true);
    expect(findVerify(none)).toBeUndefined();
  });

  it("passes over a package whose script is missing", () => {
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "package.json"), JSON.stringify({ bin: { "samesight-verify": "./gone.js" } }));
    expect(findVerify({ ...none, project: () => join(broken, "package.json"), own: () => own }, "linux")?.args).toEqual([join(root, "own/dist/cli.js")]);
    expect(findVerify({ ...none, project: () => join(root, "nowhere/package.json") })).toBeUndefined();
  });

  it("finds samesight-verify, or samesight-verify.cmd on Windows, on the PATH", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "samesight-verify"), "");
    writeFileSync(join(bin, "samesight-verify.cmd"), "");
    expect(onPath({ PATH: `${join(root, "empty")}:${bin}` }, "linux")).toBe(join(bin, "samesight-verify"));
    expect(onPath({ Path: `${join(root, "empty")};${bin}` }, "win32")).toBe(join(bin, "samesight-verify.cmd"));
    expect(onPath({ PATH: "" }, "linux")).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("forwardAudit", () => {
  const dir = mkdtempSync(join(tmpdir(), "samesight-forward-run-"));
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
