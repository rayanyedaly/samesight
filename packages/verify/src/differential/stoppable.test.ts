import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { Stack } from "../stack.ts";
import { LEFT_FOR_NEXT, leftForNext } from "../autostart/teardown.ts";
import type { TableModel } from "./model.ts";
import { cleanup, holdingLock, setUp, setUpUsers, stoppable, tearDown } from "./run.ts";

/** The connection the step opens, recording what it is asked. */
const fresh = { sql: [] as string[], lock: true, ended: false, users: [] as string[] };
const connect = vi.fn(async () => ({
  query: async (text: string) => {
    fresh.sql.push(text);
    if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: fresh.lock }] };
    if (/from auth\.users/.test(text)) return { rows: fresh.users.map((id) => ({ id })) };
    return { rows: [] };
  },
  end: async () => {
    fresh.ended = true;
  },
}));
vi.mock("../db.ts", async (original) => ({ ...(await original<typeof import("../db.ts")>()), connectLocal: () => connect() }));
/** What readModel finds, by the names asked for: none, unless a test says. */
let modelOf: (names: string[]) => unknown[] = () => [];
vi.mock("./model.ts", async (original) => ({ ...(await original<typeof import("./model.ts")>()), readModel: async (_: unknown, tables: { name: string }[]) => modelOf(tables.map((t) => t.name)) }));


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
  fresh.users = [];
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
    // The run's own backend was still ended, and the run no longer counts as holding the lock.
    expect(fresh.sql[0]).toBe("select pg_terminate_backend($1, 5000)");
    expect(holdingLock.has(client)).toBe(false);
    expect(fresh.sql.some((s) => /from auth\.users/.test(s))).toBe(false);
    expect(lines).toEqual([`could not take the run's lock to remove its users and rows; ${LEFT_FOR_NEXT}`]);
    // In policy mode, the next verify run removes them.
    const policy = runClient();
    const said: string[] = [];
    const stopPolicy = await stoppable(policy, stack, [], (l) => said.push(l), [], "policy");
    holdingLock.add(policy);
    await stopPolicy.step();
    expect(said).toEqual([`could not take the run's lock to remove its users and rows; ${leftForNext("policy")}`]);
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

  it("says a row the run may not delete blocks its users, and does not promise the next run removes them", async () => {
    const client = runClient();
    const lines: string[] = [];
    const stop = await stoppable(client, { ...stack, api: "http://127.0.0.1:54321" }, [], (l) => lines.push(l));
    holdingLock.add(client);
    fresh.users = ["0b0b0b0b-0000-4000-8000-000000000001"];
    // As Auth answers when a row still references the user.
    const body = JSON.stringify({ code: "23503", message: 'update or delete on table "users" violates foreign key constraint "messages_recipient_fkey" on table "messages"', detail: 'Key (id)=(0b0b…) is still referenced from table "messages".' });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 500 })));
    try {
      await stop.step();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(lines).toEqual([expect.stringMatching(/^could not remove the run's users and rows: could not delete 1 run users: rows in messages still reference them, and are not the run's to delete .*Remove or repoint those rows/)]);
    expect(lines[0]).not.toContain(LEFT_FOR_NEXT);
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
    expect(lines).toEqual([`could not remove the run's users and rows: refusing to connect; ${LEFT_FOR_NEXT}`]);
  });
});

describe("policy mode's setUp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets Auth pick its users' ids: it asks for none", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/auth/v1/admin/users")) {
          bodies.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ id: `0c0c0c0c-0000-4000-8000-00000000000${bodies.length}` }), { status: 200 });
        }
        return new Response("no", { status: 400 });
      }),
    );
    const client = {
      on: vi.fn(),
      query: async (text: string) => ({ rows: /pg_try_advisory_lock/.test(text) ? [{ locked: true }] : [] }),
    } as unknown as pg.Client;
    const ir = { tables: [], claims: { roles: ["admin", "member"] }, membership: { table: "members", user: "user_id", tenant: "org_id", role: "role" } };
    await expect(setUp(client, { ...stack, api: "http://127.0.0.1:54321" }, ir as never)).rejects.toThrow(/\/token/);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((b) => "id" in b)).toEqual([]);
  });
});

describe("cleanup with tables beyond the run's", () => {
  it("cleans them one at a time, children first, with their foreign keys on, and retries one that refused after the run's rows", async () => {
    const sql: string[] = [];
    let refuse = 1;
    const client = {
      query: async (text: string) => {
        sql.push(text);
        if (text.startsWith("delete from public.teams") && refuse-- > 0) throw new Error("still referenced");
        return { rows: [] };
      },
    } as unknown as pg.Client;
    const table = (name: string, parent?: string): TableModel => ({
      name,
      primaryKey: ["id"],
      unique: ["id"],
      columns: [{ name: "id", type: "uuid", nullable: false, hasDefault: false, computed: false, hints: [] }],
      foreignKeys: parent ? [{ columns: ["team_id"], schema: "public", table: parent, references: ["id"] }] : [],
    });
    await cleanup(client, stack, [table("documents")], [table("teams"), table("team_settings", "teams")]);
    expect(sql.filter((x) => x.startsWith("delete") || x.includes("replica") || x === "rollback")).toEqual([
      "delete from public.team_settings where id::text like $1",
      "delete from public.teams where id::text like $1",
      "rollback",
      // The run's own rows, past the project's triggers.
      "set local session_replication_role = replica",
      "delete from public.documents where id::text like $1",
      "delete from public.teams where id::text like $1",
    ]);
  });
});

describe("tearDown at a run's end", () => {
  it("looks in the tables beyond the run's too, as every other cleanup does", async () => {
    const sql: string[] = [];
    const client = {
      query: async (text: string) => {
        sql.push(text);
        return { rows: [] };
      },
    } as unknown as pg.Client;
    const teams: TableModel = { name: "teams", primaryKey: ["id"], unique: ["id"], columns: [{ name: "id", type: "uuid", nullable: false, hasDefault: false, computed: false, hints: [] }], foreignKeys: [] };
    modelOf = (names) => (names.includes("teams") ? [teams] : []);
    try {
      await tearDown({ client, stack, model: [], outside: ["teams"] } as never);
    } finally {
      modelOf = () => [];
    }
    expect(sql).toContain("delete from public.teams where id::text like $1");
    expect(sql.at(-1)).toBe("select pg_advisory_unlock($1)");
  });
});

describe("setUpUsers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives the run its cleanup scope, so its own tearDown looks there too", async () => {
    const token = `x.${Buffer.from(JSON.stringify({ sub: "u", role: "authenticated" })).toString("base64url")}.y`;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/auth/v1/admin/users")) return new Response(JSON.stringify({ id: (JSON.parse(String(init.body)) as { id?: string }).id ?? `id-${++n}` }), { status: 200 });
        return new Response(JSON.stringify({ access_token: token, expires_at: 2_000_000_000 }), { status: 200 });
      }),
    );
    const client = {
      on: vi.fn(),
      query: async (text: string) => ({ rows: /pg_try_advisory_lock/.test(text) ? [{ locked: true }] : [] }),
    } as unknown as pg.Client;
    const run = await setUpUsers(client, { ...stack, api: "http://127.0.0.1:54321" }, { tables: [], synced: [], cleanup: ["teams"] });
    holdingLock.delete(client);
    expect(run.outside).toEqual(["teams"]);
  });
});
