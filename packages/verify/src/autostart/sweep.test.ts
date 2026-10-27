import { describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { sweep } from "./sweep.ts";

/** A fake database: leftover roles, slots and a publication mark, recording statements. */
function db(state: { roles: string[]; slots: string[]; mark?: string | null; liveRoles?: string[] }) {
  const sql: string[] = [];
  return {
    sql,
    escapeIdentifier: (s: string) => `"${s}"`,
    escapeLiteral: (s: string) => `'${s}'`,
    query: (async (text: string, params: unknown[] = []) => {
      sql.push(text);
      if (/as role from pg_roles/.test(text)) return { rows: state.roles.map((role) => ({ role })) };
      if (/as slot from pg_replication_slots/.test(text)) return { rows: state.slots.map((slot) => ({ slot })) };
      if (/obj_description/.test(text)) return { rows: state.mark === undefined ? [] : [{ mark: state.mark }] };
      if (/as alive/.test(text)) return { rows: [{ alive: (state.liveRoles ?? []).includes(params[0] as string) }] };
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
  it("removes the project's leftover containers, idle roles, inactive slots and an orphaned publication", async () => {
    const d = docker(["samesight-audit-dead1-powersync", "samesight-audit-dead1-storage"]);
    const c = db({ roles: ["samesight_audit_dead1"], slots: ["samesight_audit_dead0_1_ab"], mark: "samesight-verify audit dead0; removed when the run ends" });
    expect(await sweep(d.docker, c, "todo")).toEqual([
      "samesight-audit-dead1-powersync",
      "samesight-audit-dead1-storage",
      "samesight_audit_dead1",
      "samesight_audit_dead0_1_ab",
      "publication powersync",
    ]);
    expect(d.calls[0]).toEqual(["ps", "--all", "--no-trunc", "--filter", "label=dev.samesight.audit.project=todo", "--format", "{{.Names}}"]);
    expect(d.calls[1]).toEqual(["rm", "--force", "--volumes", "samesight-audit-dead1-powersync", "samesight-audit-dead1-storage"]);
    expect(c.sql).toContain('drop role "samesight_audit_dead1"');
    expect(c.sql).toContain("drop publication powersync");
  });

  it("leaves the project's own publication, and one whose run is still alive", async () => {
    for (const mark of [null, "samesight-verify audit live1; removed when the run ends"]) {
      const c = db({ roles: [], slots: [], mark, liveRoles: ["samesight_audit_live1"] });
      expect(await sweep(docker([]).docker, c, "todo")).toEqual([]);
      expect(c.sql.some((s) => /drop/.test(s))).toBe(false);
    }
  });
});
