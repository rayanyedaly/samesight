import { describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { sweep } from "./sweep.ts";

/** A fake database: leftover roles and slots, recording statements. */
function db(state: { roles: string[]; slots: string[]; held?: string[] }) {
  const sql: string[] = [];
  return {
    sql,
    escapeIdentifier: (s: string) => `"${s}"`,
    escapeLiteral: (s: string) => `'${s}'`,
    query: (async (text: string, params: unknown[] = []) => {
      sql.push(text);
      if (/as slot from pg_replication_slots where starts_with/.test(text)) {
        return { rows: (state.held ?? []).filter((s) => s.startsWith(params[0] as string)).map((slot) => ({ slot })) };
      }
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

  it("leaves a role whose slot is still held for the next sweep, says so, and goes on", async () => {
    const lines: string[] = [];
    const c = db({ roles: ["samesight_audit_held1", "samesight_audit_dead2"], slots: [], held: ["samesight_audit_held1_1_ab"] });
    expect(await sweep(docker([]).docker, c, "todo", (l) => lines.push(l))).toEqual(["samesight_audit_dead2"]);
    expect(c.sql).not.toContain('drop role "samesight_audit_held1"');
    expect(c.sql).toContain('drop role "samesight_audit_dead2"');
    expect(lines).toEqual([expect.stringMatching(/could not remove samesight_audit_held1 yet: replication slot samesight_audit_held1_1_ab is still in use/)]);
  });
});
