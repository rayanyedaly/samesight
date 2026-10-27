/**
 * Audit mode on PowerSync's to-do list demo, as fetched by examples/audit-todolist: the
 * demo as published must pass, and every breakage planted here, inside a transaction that
 * is rolled back, must be caught. (The sync-side half, a planted sync config, runs as
 * examples/audit-todolist/scripts/verify-planted.sh.) PowerSync is auto-started for the
 * file, unless SAMESIGHT_AUDIT_POWERSYNC_URL names one already serving the demo.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal, rolledBack } from "../db.ts";
import { compareAll, differential, PREFIX, type Run, setUpUsers, tearDown, withWorld } from "../differential/run.ts";
import { prefixedUuid, worldArbitrary } from "../differential/world.ts";
import { type AutoStarted, autoStart } from "../autostart/run.ts";
import { readStack } from "../stack.ts";
import { checkAuditCatalog } from "./catalog.ts";
import { claimFindings, planClaims, policyFunctions, policyRules } from "./claims.ts";
import { auditTables } from "./run.ts";
import { checkWriteEscape } from "./writes.ts";

const DEMO = fileURLToPath(new URL("../../../../examples/audit-todolist/upstream/", import.meta.url));
const SYNCED = ["lists", "todos"];

let client: pg.Client;
let own: pg.Client | undefined;
let s: Run;
let started: AutoStarted | undefined;
beforeAll(async () => {
  const given = process.env.SAMESIGHT_AUDIT_POWERSYNC_URL;
  let stack = readStack(DEMO, given ?? "http://127.0.0.1");
  client = await connectLocal(stack.db);
  const tables = await auditTables(client, SYNCED);
  if (!given) {
    own = await connectLocal(stack.db);
    started = await autoStart({
      projectDir: DEMO,
      client: own,
      dbPort: Number(new URL(stack.db).port),
      api: stack.api,
      ...(stack.jwtSecret ? { jwtSecret: stack.jwtSecret } : {}),
      syncConfig: readFileSync(`${DEMO}sync-config.yaml`, "utf8"),
      tables: SYNCED,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    stack = { ...stack, powersync: started.url, slotPrefix: started.slotPrefix };
  }
  s = await setUpUsers(client, stack, { tables: tables.map((name) => ({ name })), synced: SYNCED });
}, 180_000);
afterAll(async () => {
  let left: string[] = [];
  try {
    if (s) await tearDown(s);
  } finally {
    try {
      left = (await started?.stop()) ?? [];
    } finally {
      await own?.end();
      await client?.end();
    }
  }
  expect(left).toEqual([]);
});

const world = () => fc.sample(worldArbitrary(s.tables, { minRows: 4, maxRows: 8 }), { numRuns: 1, seed: 11 })[0] ?? {};

describe("the audit catalog on the demo", () => {
  it("passes as published, listing each table's policies", async () => {
    const findings = await checkAuditCatalog(client, SYNCED);
    expect(findings.filter((f) => f.status !== "ok")).toEqual([]);
    expect(findings).toContainEqual(expect.objectContaining({ check: "policies", detail: 'todos: "todos in owned lists" (ALL to authenticated)' }));
  });

  it("fails with RLS off, a table left out of the publication, or a policy for anon", async () => {
    const findings = await rolledBack(client, async () => {
      await client.query("alter table public.todos disable row level security");
      await client.query("drop publication powersync");
      await client.query("create publication powersync for table public.lists");
      await client.query("grant select on public.lists to anon");
      await client.query("create policy anyone on public.lists for select to anon using (true)");
      return checkAuditCatalog(client, SYNCED);
    });
    expect(findings).toContainEqual(expect.objectContaining({ status: "fail", check: "row level security", detail: expect.stringMatching(/off on todos/) }));
    expect(findings).toContainEqual(expect.objectContaining({ status: "fail", check: "publication", detail: expect.stringMatching(/does not publish todos/) }));
    expect(findings).toContainEqual(expect.objectContaining({ status: "warn", check: "anon", detail: expect.stringMatching(/"anyone" on lists/) }));
  });
});

describe("claim discovery on the demo's catalog", () => {
  const discover = async () => planClaims(await policyRules(client), await policyFunctions(client));

  it("finds only the user id as published, compared with owner_id", async () => {
    const plan = await discover();
    expect(plan.uses.map((u) => u.key)).toEqual(["sub"]);
    expect(plan.identityColumns).toEqual(["owner_id"]);
    expect(claimFindings(plan, undefined)).toEqual([{ status: "ok", check: "claims", detail: "no rule reads a token claim other than the user id" }]);
  });

  it("reads through a SQL wrapper, reports a plpgsql one, and takes the user id in any spelling", async () => {
    const plan = await rolledBack(client, async () => {
      await client.query("create function public.samesight_test_role() returns text language sql stable as $$ select auth.jwt() -> 'app_metadata' ->> 'role' $$");
      await client.query(
        "create function public.samesight_test_check() returns boolean language plpgsql stable as $$ begin return auth.jwt() ->> 'tier' = 'gold'; end $$",
      );
      await client.query("create policy samesight_role on public.lists for select to authenticated using ((select public.samesight_test_role()) = 'admin')");
      await client.query("create policy samesight_check on public.lists for select to authenticated using (public.samesight_test_check())");
      await client.query("create policy samesight_sub on public.todos for select to authenticated using ((auth.jwt() ->> 'sub')::uuid = created_by)");
      return discover();
    });
    expect(plan.uses.find((u) => u.key === "app_metadata.role")).toMatchObject({ values: ["admin"], rules: ['policy "samesight_role" on lists (USING)'] });
    expect(plan.unreadable).toContainEqual(expect.objectContaining({ where: 'policy "samesight_check" on lists (USING)', reason: expect.stringMatching(/calls public\.samesight_test_check, which reads the token/) }));
    expect(plan.identityColumns).toEqual(["created_by", "owner_id"]);
  });
});

describe("the audit catalog's publication and table checks", () => {
  const planted = (sql: string[], tables = SYNCED) =>
    rolledBack(client, async () => {
      for (const q of sql) await client.query(q);
      return checkAuditCatalog(client, tables);
    });

  it("fails when the publication drops deletes or truncates", async () => {
    const findings = await planted(["alter publication powersync set (publish = 'insert, update')"]);
    expect(findings).toContainEqual(expect.objectContaining({ status: "fail", check: "publication", detail: expect.stringMatching(/does not publish delete, truncate/) }));
  });

  it("fails with no powersync publication, and on a synced table that does not exist", async () => {
    expect(await planted(["drop publication powersync"])).toContainEqual(
      expect.objectContaining({ status: "fail", check: "publication", detail: expect.stringMatching(/no powersync publication/) }),
    );
    expect(await planted([], ["lists", "nope"])).toContainEqual(
      expect.objectContaining({ status: "fail", check: "row level security", detail: expect.stringMatching(/no table public.nope/) }),
    );
  });

  it("warns on a policy calling a function whose body it cannot read", async () => {
    const findings = await planted([
      "create function public.is_open(l uuid) returns boolean language plpgsql stable as $$ begin return true; end $$",
      "create policy opened on public.lists for select to authenticated using (public.is_open(id))",
    ]);
    expect(findings).toContainEqual(expect.objectContaining({ status: "warn", check: "policies", detail: expect.stringMatching(/policy "opened" on lists calls public.is_open/) }));
  });

  it("generates rows for the tables a policy reads through a SQL-standard function", async () => {
    const tables = await rolledBack(client, async () => {
      await client.query("create table public.blocks (id uuid primary key, user_id uuid not null)");
      await client.query(
        "create function public.blocked(u uuid) returns boolean language sql stable begin atomic select exists (select 1 from public.blocks b where b.user_id = u); end",
      );
      await client.query("create policy unblocked on public.lists as restrictive for select to authenticated using (not public.blocked(owner_id))");
      return auditTables(client, SYNCED);
    });
    expect(tables).toContain("blocks");
  });

  it("warns when the publication filters a synced table's rows", async () => {
    const findings = await planted(["drop publication powersync", "create publication powersync for table public.lists where (name <> ''), public.todos"]);
    expect(findings).toContainEqual(expect.objectContaining({ status: "warn", check: "publication", detail: expect.stringMatching(/filters rows or columns of lists/) }));
  });
});

describe("the differential on the demo", () => {
  it("finds devices and RLS in agreement", async () => {
    const r = await differential(s, { runs: 1, seed: 3, timeLimitMs: 90_000 });
    expect(r.findings.filter((f) => f.status === "fail")).toEqual([]);
    expect(r.runs).toBe(1);
  }, 120_000);

  it("names the rows devices hold when RLS is narrower than the sync config", async () => {
    const narrowed = async (c: pg.Client) => {
      await c.query('drop policy "todos in owned lists" on public.todos');
      await c.query("create policy narrowed on public.todos for all to authenticated using (completed)");
    };
    const failures = await withWorld(s, world(), () => compareAll(s, { prepare: narrowed }));
    const leaks = failures.flatMap((u) => u.problems).filter((p) => p.kind === "leak");
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.every((p) => p.table === "todos" && p.row.completed !== true && p.streams.includes("user_data"))).toBe(true);
  }, 120_000);
});

describe("the write path on the demo", () => {
  it("passes as published, with writes RLS allowed", async () => {
    const findings = await checkWriteEscape(s, world());
    expect(findings).toEqual([expect.objectContaining({ status: "ok", detail: expect.stringMatching(/every insert RLS allowed \([1-9]\d*\) is readable/) })]);
  });

  it("catches an insert policy wider than the read policy", async () => {
    const findings = await checkWriteEscape(s, world(), async (c) => {
      await c.query("create policy anyone_adds on public.lists for insert to authenticated with check (true)");
    });
    expect(findings[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/inserted a lists row with owner_id u\d+, and could not read it back; u\d+ can, and their devices would receive it/) });
  });

  it("still catches it when a unique constraint stops the copy as it is", async () => {
    const findings = await checkWriteEscape(s, world(), async (c) => {
      await c.query("create unique index on public.lists (owner_id, name)");
      await c.query("create policy anyone_adds on public.lists for insert to authenticated with check (true)");
    });
    expect(findings[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/inserted a lists row with owner_id u\d+, and could not read it back/) });
  });

  it("fails on an escape into a table the streams read without sending, and only warns elsewhere", async () => {
    const anyone = async (c: pg.Client) => {
      await c.query("create policy anyone_adds on public.lists for insert to authenticated with check (true)");
    };
    // As if lists were a membership table a stream reads in a subquery.
    const readOnly = { ...s, synced: ["todos"] };
    expect((await checkWriteEscape(readOnly, world(), anyone, ["lists"]))[0]).toMatchObject({ status: "fail" });
    expect((await checkWriteEscape(readOnly, world(), anyone))[0]).toMatchObject({ status: "warn", detail: expect.stringMatching(/no other user's device/) });
  });

  it("relies on Postgres to refuse an update that hands a row to another user", async () => {
    const [owner, other] = s.fixed.users;
    const id = prefixedUuid(PREFIX);
    const refused = await rolledBack(client, async () => {
      await client.query("create policy hand_over on public.lists for update to authenticated using (auth.uid() = owner_id) with check (true)");
      await client.query("insert into public.lists (id, name, owner_id) values ($1, 'mine', $2)", [id, owner?.id]);
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(s.sessions.get(owner?.id ?? "")?.claims)]);
      return client.query("update public.lists set owner_id = $1 where id = $2", [other?.id, id]).then(
        () => null,
        (e: { code?: string }) => e.code,
      );
    });
    // The new row must pass the SELECT policy too, since the WHERE reads the table.
    expect(refused).toBe("42501");
  });
});
