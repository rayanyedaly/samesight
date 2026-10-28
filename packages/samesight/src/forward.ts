/**
 * `samesight audit` runs `samesight-verify audit`. samesight does not depend on
 * @samesight/verify (verify depends on samesight), so it is found at run time: the
 * project's own install first, then one next to samesight, then `samesight-verify` on
 * the PATH.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE = "@samesight/verify/package.json";
const BIN = "samesight-verify";

const MISSING = "samesight audit needs @samesight/verify: npm install -D @samesight/verify (or run npx @samesight/verify audit)";
export const NOT_FOUND = `samesight: ${MISSING}`;

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

/**
 * @samesight/verify's package.json beside a .cmd shim, as npm installs globally on
 * Windows: <prefix>\samesight-verify.cmd and <prefix>\node_modules\@samesight\verify.
 */
export function besideShim(shim: string): string | undefined {
  const pkg = join(dirname(shim), "node_modules", "@samesight", "verify", "package.json");
  return existsSync(pkg) ? pkg : undefined;
}

/** How to run samesight-verify, or undefined when it is nowhere to be found. */
export function findVerify(lookups: Lookups = LOOKUPS, platform: NodeJS.Platform = process.platform): Command | undefined {
  for (const find of [lookups.project, lookups.own]) {
    const pkg = find();
    const bin = pkg && binOf(pkg);
    if (bin) return { command: process.execPath, args: [bin], shell: false };
  }
  const bin = lookups.path();
  if (!bin || platform !== "win32") return bin ? { command: bin, args: [], shell: false } : undefined;
  // The shim's own script, run by this Node, needs no cmd.exe; the shim itself does.
  const pkg = besideShim(bin);
  const script = pkg && binOf(pkg);
  return script ? { command: process.execPath, args: [script], shell: false } : { command: bin, args: [], shell: true };
}

/** What cmd.exe acts on outside quotes; a caret before one makes it literal. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for an npm .cmd shim run by cmd.exe, as cross-spawn quotes it (after
 * https://qntm.org/cmd): backslashes before a quote or at the end doubled, quotes escaped,
 * the whole quoted, then every cmd.exe metacharacter caret-escaped, twice, since the
 * shim's %* is read by cmd.exe again.
 */
export function quoteForCmd(arg: string): string {
  let quoted = "";
  let slashes = 0;
  for (const c of arg) {
    if (c === "\\") {
      slashes++;
      continue;
    }
    quoted += "\\".repeat(c === '"' ? slashes * 2 + 1 : slashes) + c;
    slashes = 0;
  }
  quoted = `"${quoted}${"\\".repeat(slashes * 2)}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * The command line cmd.exe runs for a .cmd shim and its arguments. The shim's path is
 * quoted, not caret-escaped, so one with spaces (C:\Users\Jo Smith\...) is found; a
 * Windows path cannot hold a quote.
 */
export function cmdLine(shim: string, args: string[]): string {
  return [`"${shim}"`, ...args.map(quoteForCmd)].join(" ");
}

/** The signals that end a run: passed on to the child, which removes what its run made. */
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Runs `samesight-verify audit ...rest` with this terminal, and resolves with its exit
 * code: 128 plus the signal's number when a signal ended it, as a shell reports it.
 * Meanwhile this process stays up for the child's clean-up: it passes SIGINT, SIGTERM and
 * SIGHUP on to the child, so one sent to it alone reaches the child too. Ctrl+C reaches
 * both (same process group), and samesight-verify takes the same signal twice at once as
 * once. On Windows, where kill() ends a process outright, the console's Ctrl+C, Ctrl+Break
 * and close already reach the child, so they are only ignored here.
 */
export function forwardAudit(rest: string[], lookups: Lookups = LOOKUPS): Promise<number> {
  const found = findVerify(lookups);
  if (!found) return Promise.resolve(unable(MISSING, rest));
  const args = [...found.args, "audit", ...rest];
  return new Promise((done) => {
    // Listening before the child starts: a signal that comes as it starts is handled on the
    // event loop, once `child` is set, rather than ending this process at once.
    const win = process.platform === "win32";
    const handlers = (win ? [...SIGNALS, "SIGBREAK" as const] : SIGNALS).map((signal) => {
      const handler = win ? () => {} : () => child.kill(signal);
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const stop = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    let child: ChildProcess;
    try {
      // One command line, so cmd.exe reads exactly the quoting above.
      child = found.shell ? spawn(cmdLine(found.command, args), { stdio: "inherit", shell: true }) : spawn(found.command, args, { stdio: "inherit" });
    } catch (e) {
      stop();
      throw e;
    }
    child.on("error", (e) => {
      stop();
      done(unable(`could not run ${found.command}: ${e.message}`, rest));
    });
    child.on("exit", (code, signal) => {
      stop();
      done(code ?? 128 + (signal ? constants.signals[signal] : 0));
    });
  });
}

/**
 * Says why audit could not run, and returns its exit code, 2. With --json, stdout still carries one
 * document, as samesight-verify's would: the fields of its report schema that samesight
 * can fill, under its own name (no toolVersion or $schema without verify to name them), so it
 * does not validate against that schema.
 */
function unable(message: string, rest: string[]): number {
  process.stderr.write(`samesight: ${message}\n`);
  if (rest.some((a) => a === "--json" || a.startsWith("--json="))) {
    const doc = { tool: "samesight", version: 1, mode: "audit", result: "incomplete", exitCode: 2, durationMs: Math.round(performance.now()), sections: [], error: message };
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  }
  return 2;
}
