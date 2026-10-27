/**
 * The one way an auto-started run is taken down, whatever ends it: the audit finishing,
 * an error, Ctrl+C or SIGTERM. Steps are added before the thing they remove is created,
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
          this.log(`could not remove ${step.what}: ${(e as Error).message}; the next run removes it`);
        }
      }
      return failed;
    })();
    return this.done;
  }
}

/** What onSignals needs of `process`. */
export interface Signals {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): never;
}

/**
 * Runs the teardown on Ctrl+C or SIGTERM, then exits as a killed process would (130,
 * 143). A second Ctrl+C during it exits at once. Returns a function that stops listening.
 */
export function onSignals(teardown: Teardown, log: (line: string) => void, proc: Signals = process): () => void {
  const handle = (signal: "SIGINT" | "SIGTERM", code: number) => () => {
    log(`${signal}: removing what this run started (Ctrl+C again to leave it for the next run to remove)`);
    proc.once("SIGINT", () => proc.exit(code));
    void teardown.run().then(() => proc.exit(code));
  };
  const int = handle("SIGINT", 130);
  const term = handle("SIGTERM", 143);
  proc.once("SIGINT", int);
  proc.once("SIGTERM", term);
  return () => {
    proc.off("SIGINT", int);
    proc.off("SIGTERM", term);
  };
}
