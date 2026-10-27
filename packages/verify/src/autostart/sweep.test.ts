import { describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { sweep } from "./sweep.ts";

/** A fake database: leftover roles and slots, recording statements. */
function db(state: { roles: string[]; slots: string[] }) {
  const sql: string[] = [];
  return {
    sql,
    escapeIdentifier: (s: string) => `"${s}"`,
    escapeLiteral: (s: string) => `'${s}'`,
    query: (async (text: string) => {
      sql.push(text);
      if (/as role from pg_roles/.test(text)) return { rows: state.roles.map((role) => ({ role })) };
      if (/as slot from pg_replication_slots where not active/.test(text)) return { rows: state.slots.map((slot) => ({ slot })) };
      if (/as slot from pg_replication_slots/.test(text)) return { rows: [] };
      if (/exists \(select from pg_roles/.test(text)) return { rows: [{ exists: true }] };
      return { rows: [] };
    }) as never,
  };
}

function docker(containers: string[]) {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    return { stdout: args[0] === "ps" ? containers.join("\n") : "", stderr: "" };
  };
  return { docker: new Docker(exec), calls };
}

describe("sweep", () => {
  it("removes the project's leftover containers, roles and inactive slots", async () => {
    const d = docker(["samesight-audit-dead1-powersync", "samesight-audit-dead1-storage"]);
    const c = db({ roles: ["samesight_audit_dead1"], slots: ["samesight_audit_dead0_1_ab"] });
    expect(await sweep(d.docker, c, "todo")).toEqual([
      "samesight-audit-dead1-powersync",
      "samesight-audit-dead1-storage",
      "samesight_audit_dead1",
      "samesight_audit_dead0_1_ab",
    ]);
    expect(d.calls[0]).toEqual(["ps", "--all", "--no-trunc", "--filter", "label=dev.samesight.audit.project=todo", "--format", "{{.Names}}"]);
    expect(d.calls[1]).toEqual(["rm", "--force", "--volumes", "samesight-audit-dead1-powersync", "samesight-audit-dead1-storage"]);
    expect(c.sql).toContain('drop role "samesight_audit_dead1"');
    expect(c.sql).toContain("select pg_drop_replication_slot($1)");
    // The sweep drops only slots no replication holds.
    expect(c.sql).toContain("select slot_name as slot from pg_replication_slots where not active and starts_with(slot_name, $1)");
    expect(c.sql.some((s) => /publication/.test(s))).toBe(false);
  });
});
