/**
 * `samesight audit` runs `samesight-verify audit`. samesight does not depend on
 * @samesight/verify (verify depends on samesight), so it is found at run time: the
 * project's own install first, then one next to samesight, then `samesight-verify` on
 * the PATH.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE = "@samesight/verify/package.json";
const BIN = "samesight-verify";

export const NOT_FOUND = "samesight: samesight audit needs @samesight/verify: npm install -D @samesight/verify (or run npx @samesight/verify audit)";

/** Where to look, in order; each returns a path or undefined. */
export interface Lookups {
  /** @samesight/verify's package.json, as the project in the current directory resolves it. */
  project(): string | undefined;
  /** @samesight/verify's package.json, as samesight itself resolves it. */
  own(): string | undefined;
  /** `samesight-verify` on the PATH. */
  path(): string | undefined;
}

/** The command to run with `audit` and the rest of the arguments after it. */
export interface Command {
  command: string;
  args: string[];
  /** A .cmd shim on Windows runs through cmd.exe. */
  shell: boolean;
}

function tryResolve(from: string): string | undefined {
  try {
    return createRequire(from).resolve(PACKAGE);
  } catch {
    return undefined;
  }
}

/** The first `name` (name.cmd on Windows) in the PATH's directories. */
export function onPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const name = platform === "win32" ? `${BIN}.cmd` : BIN;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  return dirs.map((d) => join(d, name)).find((p) => existsSync(p));
}

export const LOOKUPS: Lookups = {
  project: () => tryResolve(join(process.cwd(), "package.json")),
  own: () => tryResolve(import.meta.url),
  path: () => onPath(),
};

/** The `samesight-verify` script a package.json names, when it is there. */
function binOf(packageJson: string): string | undefined {
  try {
    const { bin } = JSON.parse(readFileSync(packageJson, "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof bin === "string" ? bin : bin?.[BIN];
    const abs = rel === undefined ? undefined : resolve(dirname(packageJson), rel);
    return abs && existsSync(abs) ? abs : undefined;
  } catch {
    return undefined;
  }
}

/** How to run samesight-verify, or undefined when it is nowhere to be found. */
export function findVerify(lookups: Lookups = LOOKUPS, platform: NodeJS.Platform = process.platform): Command | undefined {
  for (const find of [lookups.project, lookups.own]) {
    const pkg = find();
    const bin = pkg && binOf(pkg);
    if (bin) return { command: process.execPath, args: [bin], shell: false };
  }
  const bin = lookups.path();
  return bin ? { command: bin, args: [], shell: platform === "win32" } : undefined;
}

/**
 * Runs `samesight-verify audit ...rest` with this terminal, and resolves with its exit
 * code: 128 plus the signal's number when a signal ended it, as a shell reports it.
 * Ctrl+C reaches the child itself (same process group), so meanwhile this process
 * ignores SIGINT and SIGTERM, and passes on a SIGTERM sent to it alone, while the child
 * removes what its run made.
 */
export function forwardAudit(rest: string[], lookups: Lookups = LOOKUPS): Promise<number> {
  const found = findVerify(lookups);
  if (!found) {
    process.stderr.write(`${NOT_FOUND}\n`);
    return Promise.resolve(2);
  }
  // cmd.exe joins arguments with spaces and does not quote them.
  const args = [...found.args, "audit", ...rest].map((a) => (found.shell && /\s/.test(a) ? `"${a}"` : a));
  return new Promise((done, fail) => {
    const child = spawn(found.shell ? `"${found.command}"` : found.command, args, { stdio: "inherit", shell: found.shell });
    const ignore = () => {};
    const term = () => child.kill("SIGTERM");
    process.on("SIGINT", ignore);
    process.on("SIGTERM", term);
    const stop = () => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", term);
    };
    child.on("error", (e) => {
      stop();
      fail(new Error(`could not run ${found.command}: ${e.message}`));
    });
    child.on("exit", (code, signal) => {
      stop();
      done(code ?? 128 + (signal ? constants.signals[signal] : 0));
    });
  });
}
