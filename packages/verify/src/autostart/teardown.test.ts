import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { onSignals, type Signals, Teardown } from "./teardown.ts";

describe("Teardown", () => {
  it("runs steps last first, once, and goes on past a failing one", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const t = new Teardown((l) => lines.push(l));
    t.add("role", async () => {
      order.push("role");
    });
    t.add("storage container", async () => {
      throw new Error("docker is gone");
    });
    t.add("powersync container", async () => {
      order.push("powersync");
    });
    expect(await t.run()).toEqual(["storage container"]);
    expect(await t.run()).toEqual(["storage container"]);
    expect(order).toEqual(["powersync", "role"]);
    expect(lines).toEqual(["could not remove storage container: docker is gone; the next audit that starts PowerSync removes it"]);
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
    exit: (code: number) => {
      exits.push(code);
      events.push(`exit ${code}`);
      exited(code);
      return undefined as never;
    },
  }) as unknown as Signals & EventEmitter;
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

  it("exits at once on a second Ctrl+C, and stops listening when told", async () => {
    const { p, exits } = proc();
    const t = new Teardown(() => {});
    t.add("slow", () => new Promise(() => {}));
    onSignals(t, () => {}, p);
    p.emit("SIGINT");
    p.emit("SIGINT");
    expect(exits).toEqual([130]);

    const second = proc();
    const stop = onSignals(new Teardown(() => {}), () => {}, second.p);
    stop();
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map((s) => second.p.listenerCount(s))).toEqual([0, 0, 0]);
  });
});
