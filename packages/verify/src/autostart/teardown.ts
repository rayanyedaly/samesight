/**
 * The one way an auto-started run is taken down, whatever ends it: the audit finishing,
 * an error, Ctrl+C, SIGTERM, the terminal closing (SIGHUP) or the output closing (EPIPE).
 * Steps are added before the thing they remove is created, so a run that fails half way
 * removes exactly what it made; they run in reverse order, once, and one step failing
 * does not stop the others.
 *
 * A run killed outright (SIGKILL, a crash of Docker) gets no teardown: the sweep of the
 * next audit that starts PowerSync removes what it left.
 */

export class Teardown {
  private readonly steps: { what: string; fn: () => Promise<void> }[] = [];
  private done: Promise<string[]> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly log: (line: string) => void;

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
 * other output error. While it runs, more signals do not cut it short, except Ctrl+C
 * twice. Returns a function that stops listening.
 */
export function onSignals(teardown: Teardown, log: (line: string) => void, proc: Signals = process): () => void {
  let code: number | undefined;
  let interrupts = 0;
  const end = (why: string, exitCode: number) => {
    if (code !== undefined) return;
    code = exitCode;
    try {
      log(`${why}: removing what this run started (Ctrl+C ${why === "SIGINT" ? "again" : "twice"} to leave it for the next audit that starts PowerSync)`);
    } catch {}
    void teardown.run().then(() => proc.exit(exitCode));
  };
  const handlers = [
    [
      "SIGINT",
      () => {
        interrupts++;
        if (code === undefined) end("SIGINT", 130);
        else if (interrupts >= 2) proc.exit(code);
      },
    ],
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
