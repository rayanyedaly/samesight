/**
 * The one way an auto-started run is taken down, whatever ends it: the audit finishing,
 * an error, Ctrl+C, SIGTERM or the terminal closing (SIGHUP). Steps are added before the thing they remove is created,
 * so a run that fails half way removes exactly what it made; they run in reverse order,
 * once, and one step failing does not stop the others.
 *
 * A run killed outright (SIGKILL, a crash of Docker) gets no teardown: the next run's
 * sweep removes what it left.
 */

export class Teardown {
  private readonly steps: { what: string; fn: () => Promise<void> }[] = [];
  private done: Promise<string[]> | undefined;
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.log = log;
  }

  add(what: string, fn: () => Promise<void>): void {
    this.steps.push({ what, fn });
  }

  /** Runs every step, last added first; resolves with what could not be removed. */
  run(): Promise<string[]> {
    this.done ??= (async () => {
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

/** What onSignals needs of `process`. */
type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface Signals {
  once(event: Signal, listener: () => void): unknown;
  off(event: Signal, listener: () => void): unknown;
  exit(code: number): never;
}

/**
 * Runs the teardown on Ctrl+C, SIGTERM or SIGHUP, then exits as a killed process would
 * (130, 143, 129). A second Ctrl+C during it exits at once. Returns a function that
 * stops listening.
 */
export function onSignals(teardown: Teardown, log: (line: string) => void, proc: Signals = process): () => void {
  const handle = (signal: Signal, code: number) => () => {
    log(`${signal}: removing what this run started (Ctrl+C again to leave it for the next run to remove)`);
    proc.once("SIGINT", () => proc.exit(code));
    void teardown.run().then(() => proc.exit(code));
  };
  const handlers = [
    ["SIGINT", handle("SIGINT", 130)],
    ["SIGTERM", handle("SIGTERM", 143)],
    ["SIGHUP", handle("SIGHUP", 129)],
  ] as const;
  for (const [signal, fn] of handlers) proc.once(signal, fn);
  return () => {
    for (const [signal, fn] of handlers) proc.off(signal, fn);
  };
}
