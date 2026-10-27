import { describe, expect, it } from "vitest";
import { runName, setUpReplication, tearDownReplication } from "./replication.ts";

/** A fake client that records statements and answers the role check from `state`. */
function client(state: { role?: boolean }) {
  const sql: string[] = [];
  return {
    sql,
    escapeIdentifier: (s: string) => `"${s.replaceAll('"', '""')}"`,
    escapeLiteral: (s: string) => `'${s.replaceAll("'", "''")}'`,
    query: (async (text: string) => {
      sql.push(text);
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
  it("creates a marked replication role that reads only the given tables", async () => {
    const c = client({});
    const r = await setUpReplication(c, "a1b2c3d4", ["lists", 'Odd"Name']);
    expect(r).toMatchObject({ role: "samesight_audit_a1b2c3d4", slotPrefix: "samesight_audit_a1b2c3d4_" });
    expect(r.password).toMatch(/^[0-9a-f]{48}$/);
    // Only the SCRAM verifier reaches the server, never the password itself.
    expect(c.sql[0]).toMatch(/^create role "samesight_audit_a1b2c3d4" with login replication bypassrls password 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'$/);
    expect(c.sql.join("\n")).not.toContain(r.password);
    expect(c.sql.slice(1)).toEqual([
      `comment on role "samesight_audit_a1b2c3d4" is 'samesight-verify audit a1b2c3d4; removed when the run ends'`,
      'grant usage on schema public to "samesight_audit_a1b2c3d4"',
      'grant select on public."lists", public."Odd""Name" to "samesight_audit_a1b2c3d4"',
    ]);
  });

  it("never touches the project's publication", async () => {
    const c = client({});
    await setUpReplication(c, "a1b2c3d4", ["lists"]);
    await tearDownReplication(c, { role: "samesight_audit_a1b2c3d4", slotPrefix: "samesight_audit_a1b2c3d4_" });
    expect(c.sql.some((s) => /publication/.test(s))).toBe(false);
  });
});

describe("tearDownReplication", () => {
  const r = { role: "samesight_audit_a1b2c3d4", slotPrefix: "samesight_audit_a1b2c3d4_" };

  it("drops the run's slots, waiting for their replication to end, then its role", async () => {
    const c = client({});
    await tearDownReplication(c, r);
    expect(c.sql.filter((s) => !s.startsWith("select exists"))).toEqual([
      "select pg_terminate_backend(active_pid, 5000) from pg_replication_slots where active and starts_with(slot_name, $1)",
      "select pg_drop_replication_slot(slot_name) from pg_replication_slots where not active and starts_with(slot_name, $1)",
      "select pg_terminate_backend(pid, 5000) from pg_stat_activity where usename = $1",
      'revoke all on all tables in schema public from "samesight_audit_a1b2c3d4"',
      'revoke all on schema public from "samesight_audit_a1b2c3d4"',
      'drop role "samesight_audit_a1b2c3d4"',
    ]);
  });

  it("skips a role already gone", async () => {
    const c = client({ role: false });
    await tearDownReplication(c, r);
    expect(c.sql.some((s) => /drop role|revoke/.test(s))).toBe(false);
  });
});
