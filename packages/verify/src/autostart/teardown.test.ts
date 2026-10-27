import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { LEFT_FOR_NEXT, leftForNext, onSignals, type Signals, Teardown } from "./teardown.ts";

describe("Teardown", () => {
  it("runs steps last first, once, and goes on past a failing one", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const t = new Teardown((l) => lines.push(l));
    t.add("role", async () => {
      order.push("role");
    });
    t.add(
      "storage container",
      async () => {
        throw new Error("docker is gone");
      },
      "the next audit that starts PowerSync removes it",
    );
    t.add("sync config", async () => {
      throw new Error("read-only file system");
    });
    t.add("powersync container", async () => {
      order.push("powersync");
    });
    expect(await t.run()).toEqual(["sync config", "storage container"]);
    expect(await t.run()).toEqual(["sync config", "storage container"]);
    expect(order).toEqual(["powersync", "role"]);
    // Each failure says its own remedy, if it has one.
    expect(lines).toEqual(["could not remove sync config: read-only file system", "could not remove storage container: docker is gone; the next audit that starts PowerSync removes it"]);
  });
});

describe("Teardown.step", () => {
  it("makes a teardown begun mid-step wait for it, and refuses the steps after", async () => {
    const events: string[] = [];
    const t = new Teardown(() => {});
    t.add("container", async () => {
      events.push("removed");
    });
    let finish: () => void = () => {};
    const step = t.step(
      () =>
        new Promise<void>((r) => {
          finish = () => {
            events.push("created");
            r();
          };
        }),
    );
    const done = t.run();
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([]);
    finish();
    await step;
    await done;
    expect(events).toEqual(["created", "removed"]);
    expect(t.started).toBe(true);
    await expect(t.step(async () => events.push("too late"))).rejects.toThrow(/stopped/);
    expect(events).toEqual(["created", "removed"]);
  });
});

/** A process stand-in: emits signals, records exits in `events`, and resolves `exited` on the first. */
function proc(events: string[] = []) {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  let exited: (code: number) => void = () => {};
  const first = new Promise<number>((r) => {
    exited = r;
  });
  const p = Object.assign(emitter, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exit: (code: number) => {
      exits.push(code);
      events.push(`exit ${code}`);
      exited(code);
      return undefined as never;
    },
  }) as unknown as Signals & EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  return { p, exits, exited: first };
}

describe("onSignals", () => {
  it("tears down on Ctrl+C, SIGTERM or SIGHUP, then exits as a killed process would", async () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const events: string[] = [];
      const { p, exited } = proc(events);
      const t = new Teardown(() => {});
      t.add("x", async () => {
        await new Promise((r) => setTimeout(r, 5));
        events.push("removed x");
      });
      onSignals(t, () => {}, p);
      p.emit(signal);
      await exited;
      expect(events, signal).toEqual(["removed x", `exit ${code}`]);
    }
  });

  it("takes Ctrl+Break (SIGBREAK) on Windows only", async () => {
    const win = proc();
    win.p.platform = "win32";
    const t = new Teardown(() => {});
    onSignals(t, () => {}, win.p);
    win.p.emit("SIGBREAK");
    expect(await win.exited).toBe(149);
    const linux = proc();
    linux.p.platform = "linux";
    onSignals(new Teardown(() => {}), () => {}, linux.p);
    expect(linux.p.listenerCount("SIGBREAK")).toBe(0);
  });

  it("tears down and exits 141 when its output has gone (EPIPE), or 1 on another output error", async () => {
    for (const [errno, code] of [
      ["EPIPE", 141],
      ["EIO", 141],
      ["ENOSPC", 1],
    ] as const) {
      const events: string[] = [];
      const { p, exited } = proc(events);
      const t = new Teardown(() => {});
      t.add("x", async () => {
        events.push("removed x");
      });
      onSignals(t, () => {}, p);
      p.stderr.emit("error", Object.assign(new Error(`write ${errno}`), { code: errno }));
      p.stdout.emit("error", Object.assign(new Error(`write ${errno}`), { code: errno }));
      await exited;
      expect(events, errno).toEqual(["removed x", `exit ${code}`]);
    }
  });

  it("lets one Ctrl+C or another signal during a teardown not cut it short", async () => {
    const events: string[] = [];
    const { p, exited } = proc(events);
    const t = new Teardown(() => {});
    let finish: () => void = () => {};
    t.add("slow", () => new Promise<void>((r) => (finish = r)));
    onSignals(t, () => {}, p);
    p.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    p.emit("SIGINT");
    p.emit("SIGTERM");
    p.emit("SIGHUP");
    // Still listening: a lost listener would let a real process's next signal kill it.
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => p.listenerCount(s))).toEqual([1, 1, 1]);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([]);
    finish();
    await exited;
    expect(events).toEqual(["exit 141"]);
  });

  it("exits at once on the same signal again a second later, not on one sent twice at once (npx forwards it)", async () => {
    let time = 0;
    const clock = () => time;
    const twice = proc();
    const hung = new Teardown(() => {});
    hung.add("hung", () => new Promise(() => {}));
    onSignals(hung, () => {}, twice.p, 120_000, clock);
    twice.p.emit("SIGTERM");
    twice.p.emit("SIGTERM");
    expect(twice.exits).toEqual([]);
    time = 1500;
    twice.p.emit("SIGTERM");
    expect(twice.exits).toEqual([143]);
  });

  it("exits when the teardown outlasts its grace, whatever began it", async () => {
    const late = proc();
    const slow = new Teardown(() => {});
    slow.add("hung", () => new Promise(() => {}));
    const lines: string[] = [];
    onSignals(slow, (l) => lines.push(l), late.p, 20);
    late.p.emit("SIGHUP");
    expect(await late.exited).toBe(129);
    // What is left may hold privileged run users: said, with how to remove them now; no service was started.
    expect(lines.at(-1)).toBe(`stopped before the clean-up finished: ${LEFT_FOR_NEXT}`);

    // With a service started, what is left of it too; in policy mode, the next verify run removes the users.
    for (const [mode, service, said] of [
      ["audit", true, `the next audit that starts PowerSync removes what is left of the service it started, and ${LEFT_FOR_NEXT}`],
      ["policy", false, leftForNext("policy")],
    ] as const) {
      const p = proc();
      const t = new Teardown(() => {}, mode);
      t.service = service;
      t.add("hung", () => new Promise(() => {}));
      const said2: string[] = [];
      onSignals(t, (l) => said2.push(l), p.p, 20);
      p.p.emit("SIGINT");
      expect(await p.exited).toBe(130);
      expect(said2.at(-1)).toBe(`stopped before the clean-up finished: ${said}`);
    }
    expect(leftForNext("policy")).toMatch(/^the next verify run removes the run's users and rows .*with no verify run running/);

    // Begun by the run itself (its end): the grace starts with the signal.
    const own = proc();
    const t = new Teardown(() => {});
    t.add("hung", () => new Promise(() => {}));
    onSignals(t, () => {}, own.p, 20);
    void t.run();
    await new Promise((r) => setTimeout(r, 30));
    expect(own.exits).toEqual([]);
    own.p.emit("SIGTERM");
    expect(await own.exited).toBe(143);
  });

  it("leaves a teardown the run began itself to finish and report", async () => {
    const { p, exits } = proc();
    const t = new Teardown(() => {});
    let finish: () => void = () => {};
    t.add("slow", () => new Promise<void>((r) => (finish = r)));
    onSignals(t, () => {}, p);
    const done = t.run();
    p.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([]);
    finish();
    await done;
    await new Promise((r) => setTimeout(r, 5));
    expect(exits).toEqual([]);
  });

  it("exits at once on Ctrl+C again, whatever began the teardown, and stops listening when told", async () => {
    let time = 0;
    const clock = () => time;
    const { p, exits } = proc();
    const t = new Teardown(() => {});
    t.add("slow", () => new Promise(() => {}));
    const lines: string[] = [];
    onSignals(t, (l) => lines.push(l), p, 120_000, clock);
    p.emit("SIGINT");
    time = 1000;
    p.emit("SIGINT");
    expect(exits).toEqual([130]);
    // Cut short: what is left is said.
    expect(lines.at(-1)).toMatch(/^stopped before the clean-up finished: /);

    const after = proc();
    const slow = new Teardown(() => {});
    slow.add("slow", () => new Promise(() => {}));
    onSignals(slow, () => {}, after.p, 120_000, clock);
    after.p.emit("SIGTERM");
    after.p.emit("SIGINT");
    expect(after.exits).toEqual([]);
    time = 2500;
    after.p.emit("SIGINT");
    expect(after.exits).toEqual([143]);

    // A teardown that has finished says nothing is left, however the exit comes.
    const done = proc();
    const quick = new Teardown(() => {});
    const quiet: string[] = [];
    onSignals(quick, (l) => quiet.push(l), done.p, 120_000, clock);
    await quick.run();
    time = 4000;
    done.p.emit("SIGINT");
    time = 5500;
    done.p.emit("SIGINT");
    expect(quiet.some((l) => l.startsWith("stopped before the clean-up finished"))).toBe(false);

    const second = proc();
    const stop = onSignals(new Teardown(() => {}), () => {}, second.p);
    stop();
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => second.p.listenerCount(s))).toEqual([0, 0, 0]);
    expect([second.p.stdout.listenerCount("error"), second.p.stderr.listenerCount("error")]).toEqual([0, 0]);
  });
});
