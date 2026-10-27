import { describe, expect, it } from "vitest";
import { PUBLICATION, runName, setUpReplication, tearDownReplication } from "./replication.ts";

/** A fake client that records statements and answers the existence checks from `state`. */
function client(state: { publication?: string | null; role?: boolean }) {
  const sql: string[] = [];
  return {
    sql,
    escapeIdentifier: (s: string) => `"${s.replaceAll('"', '""')}"`,
    escapeLiteral: (s: string) => `'${s.replaceAll("'", "''")}'`,
    query: (async (text: string) => {
      sql.push(text);
      if (/exists \(select from pg_publication/.test(text)) return { rows: [{ exists: state.publication !== undefined }] };
      if (/obj_description/.test(text)) return { rows: state.publication === undefined ? [] : [{ mark: state.publication }] };
      if (/exists \(select from pg_roles/.test(text)) return { rows: [{ exists: state.role ?? true }] };
      return { rows: [] };
    }) as never,
  };
}

describe("runName", () => {
  it("is lowercase hex, fit for role, slot and container names", () => {
    expect(runName()).toMatch(/^[0-9a-f]{8}$/);
    expect(runName()).not.toBe(runName());
  });
});

describe("setUpReplication", () => {
  it("creates a marked replication role that reads only the given tables, and the publication when there is none", async () => {
    const c = client({});
    const r = await setUpReplication(c, "a1b2c3d4", ["lists", 'Odd"Name']);
    expect(r).toMatchObject({ role: "samesight_audit_a1b2c3d4", slotPrefix: "samesight_audit_a1b2c3d4_", createdPublication: true });
    expect(r.password).toMatch(/^[0-9a-f]{48}$/);
    expect(c.sql).toEqual([
      `create role "samesight_audit_a1b2c3d4" with login replication bypassrls password '${r.password}'`,
      `comment on role "samesight_audit_a1b2c3d4" is 'samesight-verify audit a1b2c3d4; removed when the run ends'`,
      'grant usage on schema public to "samesight_audit_a1b2c3d4"',
      'grant select on public."lists", public."Odd""Name" to "samesight_audit_a1b2c3d4"',
      "select exists (select from pg_publication where pubname = $1) as exists",
      `create publication ${PUBLICATION} for table public."lists", public."Odd""Name"`,
      `comment on publication ${PUBLICATION} is 'samesight-verify audit a1b2c3d4; removed when the run ends'`,
    ]);
  });

  it("leaves the project's own publication alone", async () => {
    const c = client({ publication: null });
    expect((await setUpReplication(c, "a1b2c3d4", ["lists"])).createdPublication).toBe(false);
    expect(c.sql.some((s) => /create publication/.test(s))).toBe(false);
  });
});

describe("tearDownReplication", () => {
  const r = { run: "a1b2c3d4", role: "samesight_audit_a1b2c3d4", slotPrefix: "samesight_audit_a1b2c3d4_", createdPublication: true };

  it("drops the run's slots, its publication and its role", async () => {
    const c = client({ publication: "samesight-verify audit a1b2c3d4; removed when the run ends" });
    await tearDownReplication(c, r);
    expect(c.sql.filter((s) => !s.startsWith("select exists") && !/obj_description/.test(s))).toEqual([
      "select pg_terminate_backend(active_pid) from pg_replication_slots where active and starts_with(slot_name, $1)",
      "select pg_drop_replication_slot(slot_name) from pg_replication_slots where not active and starts_with(slot_name, $1)",
      `drop publication ${PUBLICATION}`,
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1",
      'revoke all on all tables in schema public from "samesight_audit_a1b2c3d4"',
      'revoke all on schema public from "samesight_audit_a1b2c3d4"',
      'drop role "samesight_audit_a1b2c3d4"',
    ]);
  });

  it("keeps a publication someone else has since made, and skips a role already gone", async () => {
    const c = client({ publication: null, role: false });
    await tearDownReplication(c, r);
    expect(c.sql.some((s) => /drop publication|drop role|revoke/.test(s))).toBe(false);
  });
});
