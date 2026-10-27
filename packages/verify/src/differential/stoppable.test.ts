import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Stack } from "../stack.ts";
import { holdingLock, stoppable } from "./run.ts";

/** The connection the step opens, recording what it is asked. */
const fresh = { sql: [] as string[], lock: true, ended: false };
const connect = vi.fn(async () => ({
  query: async (text: string) => {
    fresh.sql.push(text);
    if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: fresh.lock }] };
    return { rows: [] };
  },
  end: async () => {
    fresh.ended = true;
  },
}));
vi.mock("../db.ts", async (original) => ({ ...(await original<typeof import("../db.ts")>()), connectLocal: () => connect() }));
vi.mock("./model.ts", async (original) => ({ ...(await original<typeof import("./model.ts")>()), readModel: async () => [] }));


const stack = { db: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" } as Stack;
/** The run's own connection: its backend id, and the statements it is sent. */
function runClient() {
  const sql: string[] = [];
  return {
    sql,
    on: vi.fn(),
    query: async (text: string) => {
      sql.push(text);
      return { rows: /pg_backend_pid/.test(text) ? [{ pid: 4242 }] : [] };
    },
  } as unknown as pg.Client & { sql: string[] };
}

beforeEach(() => {
  fresh.sql = [];
  fresh.lock = true;
  fresh.ended = false;
  connect.mockClear();
});

describe("stoppable", () => {
  it("does nothing while the run does not hold the lock: a refused run never cleans", async () => {
    const lines: string[] = [];
    const stop = await stoppable(runClient(), stack, [], (l) => lines.push(l));
    await stop.step();
    expect([connect.mock.calls.length, lines]).toEqual([0, []]);
  });

  it("ends the run's backend, takes the lock on a connection of its own, cleans up and lets go", async () => {
    const client = runClient();
    const lines: string[] = [];
    const stop = await stoppable(client, stack, [], (l) => lines.push(l));
    holdingLock.add(client);
    await stop.step();
    expect(fresh.sql[0]).toBe("select pg_terminate_backend($1, 5000)");
    expect(fresh.sql).toContain("select pg_try_advisory_lock($1) as locked");
    expect(fresh.sql.some((s) => /from auth\.users/.test(s))).toBe(true);
    expect(fresh.sql.at(-1)).toBe("select pg_advisory_unlock($1)");
    expect([fresh.ended, lines, holdingLock.has(client)]).toEqual([true, [], false]);
    // The run's own tearDown, on its ended connection, then does nothing.
    const before = client.sql.length;
    await stop.tearDown({ client } as never);
    expect(client.sql.length).toBe(before);
  });

  it("leaves the users and rows for the next run when another holds the lock by then", async () => {
    const client = runClient();
    const lines: string[] = [];
    const stop = await stoppable(client, stack, [], (l) => lines.push(l));
    holdingLock.add(client);
    fresh.lock = false;
    await stop.step();
    expect(fresh.sql.some((s) => /from auth\.users/.test(s))).toBe(false);
    expect(lines).toEqual(["could not take the run's lock to remove its users and rows; the next run removes them"]);
  });

  it("waits for the run's own tearDown when it has begun, instead of cleaning twice", async () => {
    const client = runClient();
    const stop = await stoppable(client, stack, [], () => {});
    holdingLock.add(client);
    // Begun first, it runs on the run's own connection; the step only waits for it.
    const ending = stop.tearDown({ client, stack, model: [] } as never);
    await stop.step();
    await ending;
    expect(connect.mock.calls.length).toBe(0);
    expect(client.sql.at(-1)).toBe("select pg_advisory_unlock($1)");
  });

  it("logs, never throws, when it cannot clean", async () => {
    const client = runClient();
    const lines: string[] = [];
    const stop = await stoppable(client, stack, [], (l) => lines.push(l));
    holdingLock.add(client);
    connect.mockImplementationOnce(async () => {
      throw new Error("refusing to connect");
    });
    await expect(stop.step()).resolves.toBeUndefined();
    expect(lines).toEqual(["could not remove the run's users and rows: refusing to connect; the next run removes them"]);
  });
});
