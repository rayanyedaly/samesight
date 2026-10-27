/**
 * The one way an audit run is taken down, whatever ends it: the audit finishing,
 * an error, Ctrl+C, SIGTERM, the terminal closing (SIGHUP) or the output closing (EPIPE).
 * Steps are added before the thing they remove is created, so a run that fails half way
 * removes exactly what it made; they run in reverse order, once, and one step failing
 * does not stop the others.
 *
 * A run killed outright (SIGKILL, a crash of Docker) gets no teardown: the sweep of the
 * next audit that starts PowerSync removes its service, and the next to reach the
 * differential its users and rows.
 */

export class Teardown {
  private readonly steps: { what: string; fn: () => Promise<void> }[] = [];
  private done: Promise<string[]> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly log: (line: string) => void;
  /** What began the teardown, when onSignals did (SIGINT, output closed): the run did not end on its own. */
  stoppedBy: string | undefined;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  add(what: string, fn: () => Promise<void>): void {
    this.steps.push({ what, fn });
  }

  /** Whether the teardown has begun: a run still starting stops at its next step. */
  get started(): boolean {
    return this.done !== undefined;
  }

  /**
   * Runs a step of the start, unless the teardown has begun; a teardown begun meanwhile
   * (Ctrl+C) waits for it to settle, so nothing is made after it was removed.
   */
  step<T>(fn: () => Promise<T>): Promise<T> {
    if (this.started) return Promise.reject(new Error("stopped"));
    // Recorded before the step begins, so a teardown begun at any point of it waits for it.
    const p = Promise.resolve().then(fn);
    this.pending = p.catch(() => {});
    return p;
  }

  /** Runs every step, last added first; resolves with what could not be removed. */
  run(): Promise<string[]> {
    this.done ??= (async () => {
      await this.pending;
      const failed: string[] = [];
      for (const step of [...this.steps].reverse()) {
        try {
          await step.fn();
        } catch (e) {
          failed.push(step.what);
          this.log(`could not remove ${step.what}: ${(e as Error).message}; the next audit that starts PowerSync removes it`);
        }
      }
      return failed;
    })();
    return this.done;
  }
}

type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** What onSignals needs of `process`. */
export interface Signals {
  on(event: Signal, listener: () => void): unknown;
  off(event: Signal, listener: () => void): unknown;
  exit(code: number): never;
  stdout: Pick<NodeJS.EventEmitter, "on" | "off">;
  stderr: Pick<NodeJS.EventEmitter, "on" | "off">;
}

/**
 * Runs the teardown on Ctrl+C, SIGTERM or SIGHUP, then exits as a killed process would
 * (130, 143, 129); and when the output fails (a closed terminal, or a reader that left:
 * | head, | tee), exits 141 as on SIGPIPE (129 when SIGHUP comes first), or 1 for any
 * other output error. During it, a different signal does not cut it short; the same one
 * again a second or more later (Ctrl+C again, a second SIGTERM) exits at once, and so
 * does a teardown still running `graceMs` after the first. A teardown begun by the run
 * itself (its end, an error) is left to finish and report. Returns a
 * function that stops listening.
 */
/** How far apart the same signal must come to count twice. */
const REPEAT_MS = 1000;

export function onSignals(
  teardown: Teardown,
  log: (line: string) => void,
  proc: Signals = process,
  graceMs = 120_000,
  now: () => number = Date.now,
): () => void {
  let code: number | undefined;
  const first = new Map<string, number>();
  const end = (why: string, exitCode: number) => {
    const at = now();
    const firstAt = first.get(why);
    if (firstAt === undefined) first.set(why, at);
    if (code !== undefined) {
      // Only a signal sent again means "now": a broken output errors on each write, and
      // the same signal can arrive twice at once (from the terminal, and forwarded by npx).
      if (firstAt !== undefined && at - firstAt >= REPEAT_MS && why !== "output closed") proc.exit(code);
      return;
    }
    code = exitCode;
    try {
      log(`${why}: removing what this run made (${why === "SIGINT" ? "Ctrl+C again" : "Ctrl+C twice"} to leave it for the next audit)`);
    } catch {}
    setTimeout(() => proc.exit(exitCode), graceMs).unref();
    // A teardown the run began itself finishes and reports on its own.
    if (!teardown.started) {
      teardown.stoppedBy = why;
      void teardown.run().then(() => proc.exit(exitCode));
    }
  };
  const handlers = [
    ["SIGINT", () => end("SIGINT", 130)],
    ["SIGTERM", () => end("SIGTERM", 143)],
    ["SIGHUP", () => end("SIGHUP", 129)],
  ] as const;
  // Unhandled, a failed write would end the process at once, before any teardown.
  const broken = (e: NodeJS.ErrnoException) => end("output closed", e.code === "EPIPE" || e.code === "EIO" ? 141 : 1);
  for (const [signal, fn] of handlers) proc.on(signal, fn);
  proc.stdout.on("error", broken);
  proc.stderr.on("error", broken);
  return () => {
    for (const [signal, fn] of handlers) proc.off(signal, fn);
    proc.stdout.off("error", broken);
    proc.stderr.off("error", broken);
  };
}
