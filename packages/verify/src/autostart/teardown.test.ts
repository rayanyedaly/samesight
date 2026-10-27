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
    expect(lines).toEqual(["could not remove storage container: docker is gone; the next run removes it"]);
  });
});

/** A process stand-in: emits signals, records exits. */
function proc() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const p = Object.assign(emitter, {
    exit: (code: number) => {
      exits.push(code);
      return undefined as never;
    },
  }) as unknown as Signals & EventEmitter;
  return { p, exits };
}

describe("onSignals", () => {
  it("tears down on Ctrl+C or SIGTERM, then exits as a killed process would", async () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const { p, exits } = proc();
      const removed: string[] = [];
      const t = new Teardown(() => {});
      t.add("x", async () => {
        removed.push("x");
      });
      onSignals(t, () => {}, p);
      p.emit(signal);
      await t.run();
      await new Promise((r) => setImmediate(r));
      expect([removed, exits], signal).toEqual([["x"], [code]]);
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
    expect(second.p.listenerCount("SIGINT") + second.p.listenerCount("SIGTERM")).toBe(0);
  });
});
