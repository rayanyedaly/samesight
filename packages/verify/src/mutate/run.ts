/**
 * The mutation test: every mutant of the generated access layer must make the differential
 * fail. RLS mutants run against devices synced once per dataset; sync mutants run together
 * under one combined config (one PowerSync reload), each caught when a row it alone should
 * not have sent reaches a device.
 */

import type { Teardown } from "../autostart/teardown.ts";
import fc from "fast-check";
import { parse } from "yaml";
import type { Finding } from "../report.ts";
import { parseStreams } from "samesight/compiler";
import { compareAll, describeFailures, type Setup, syncAll, withWorld } from "../differential/run.ts";
import { worldArbitrary } from "../differential/world.ts";
import { type Equivalent, mutantConfig, type RlsMutant, rlsMutants, type SyncMutant, syncMutants } from "./mutants.ts";
import { type Sent, sentBy } from "./explain.ts";
import { type PowerSyncControl, withSyncConfig } from "./reload.ts";

export interface MutationOptions {
  /** Datasets to try before declaring a mutant missed. */
  maxWorlds: number;
  seed?: number;
  log?: (line: string) => void;
  /** The run's teardown: a stop puts the sync config back as a step of it. */
  teardown?: Teardown;
}

export interface MutationResult {
  findings: Finding[];
  caught: { name: string; description: string; example: string }[];
  missed: { name: string; description: string }[];
  equivalent: Equivalent[];
}

export async function mutationTest(s: Setup, ps: PowerSyncControl, syncYaml: string, options: MutationOptions): Promise<MutationResult> {
  const unique = (table: string, column: string) => s.model.find((t) => t.name === table)?.unique.includes(column) ?? false;
  const roleColumn = s.model.find((t) => t.name === s.ir.membership.table)?.columns.find((c) => c.name === s.ir.membership.role);
  const closedRoles = roleColumn !== undefined && !roleColumn.nullable && (roleColumn.values ?? []).length > 0 && (roleColumn.values ?? []).every((v) => s.ir.claims.roles.includes(v));
  const streams = parseStreams(syncYaml);
  const sync = syncMutants(s.ir, streams, unique, closedRoles);
  const rls = rlsMutants(s.ir, unique);
  // The unmutated streams, to tell a leak of the original layer from a mutant's.
  const originals: SyncMutant[] = streams.map((x) => ({ name: x.name, description: x.name, ctes: Object.fromEntries(x.ctes), queries: x.queries.map((q) => q.sql) }));
  const worlds = fc.sample(worldArbitrary(s.tables, { minRows: 6, maxRows: 20 }), { numRuns: options.maxWorlds, ...(options.seed !== undefined ? { seed: options.seed } : {}) });
  const log = options.log ?? (() => {});
  const caught = new Map<string, string>();
  const genuine: string[] = [];

  // RLS mutants: one sync per dataset, then each mutant policy in a rolled-back read.
  const rlsLeft = (): RlsMutant[] => rls.mutants.filter((m) => !caught.has(m.name));
  for (const [n, world] of worlds.entries()) {
    if (!rlsLeft().length) break;
    await withWorld(s, world, async () => {
      const devices = await syncAll(s);
      log(`RLS mutants, dataset ${n + 1}: ${rlsLeft().length} left${rlsLeft().length <= 3 ? ` (${rlsLeft().map((m) => m.description).join("; ")})` : ""}`);
      const baseline = await compareAll(s, { devices });
      if (baseline.length) {
        genuine.push(...describeFailures(s, baseline));
        return;
      }
      for (const m of rlsLeft()) {
        const failures = await compareAll(s, {
          devices,
          prepare: async (client) => {
            for (const sql of m.statements) await client.query(sql);
          },
        });
        const [first] = describeFailures(s, failures);
        if (first) caught.set(m.name, first);
      }
    });
    if (genuine.length) break;
  }

  // Sync mutants: all at once, each in a stream of its own. A leaked row is put down to every
  // mutant whose own query, run for that user, returns it (and, for a hidden column, sends it).
  const syncLeft = (): SyncMutant[] => sync.mutants.filter((m) => !caught.has(m.name));
  if (!genuine.length && sync.mutants.length) {
    log(`loading ${sync.mutants.length} sync mutants into PowerSync`);
    await withSyncConfig(s.client, ps, mutantConfig(parse(syncYaml), sync.mutants), async () => {
      log("loaded");
      for (const [n, world] of worlds.entries()) {
        if (!syncLeft().length) break;
        log(`sync mutants, dataset ${n + 1}: ${syncLeft().length} left${syncLeft().length <= 3 ? ` (${syncLeft().map((m) => m.description).join("; ")})` : ""}`);
        await withWorld(s, world, async () => {
          for (const { user, problems } of await compareAll(s)) {
            const claims = s.sessions.get(user.id)?.claims ?? {};
            const sent = new Map<string, Sent>();
            for (const m of [...originals, ...sync.mutants]) sent.set(m.name, await sentBy(s.client, m, claims));
            for (const p of problems) {
              const [line = ""] = describeFailures(s, [{ user, problems: [p] }]);
              const key = `${p.table}\u0000${p.id}`;
              const sends = (m: SyncMutant) => {
                const cols = sent.get(m.name)?.rows.get(key);
                if (cols === undefined) return false;
                if (p.kind === "leak") return true;
                return p.kind === "hidden" && (cols === true || (p.columns ?? []).some((c) => cols.has(c)));
              };
              // Sent by an original stream too: the unmutated layer leaks, whatever the mutants do.
              // Sent by several mutants: each would leak it alone, so each is caught.
              const by = originals.some(sends) ? [] : sync.mutants.filter(sends);
              if (!by.length) genuine.push(line);
              for (const m of by) if (!caught.has(m.name)) caught.set(m.name, line);
            }
          }
        });
        if (genuine.length) break;
      }
    }, options.teardown);
  }

  const all = [...rls.mutants, ...sync.mutants];
  const result: MutationResult = {
    caught: all.filter((m) => caught.has(m.name)).map((m) => ({ name: m.name, description: m.description, example: caught.get(m.name) ?? "" })),
    missed: all.filter((m) => !caught.has(m.name)).map((m) => ({ name: m.name, description: m.description })),
    equivalent: [...rls.equivalent, ...sync.equivalent],
    findings: [],
  };
  const check = "mutation";
  if (!all.length) {
    result.findings.push({ status: "fail", check, detail: "no mutants could be made from this policy, so the test proves nothing" });
  } else if (genuine.length) {
    result.findings.push({ status: "fail", check, detail: `the unmutated layer already fails, so mutants prove nothing:\n${genuine.map((l) => `    ${l}`).join("\n")}` });
  } else if (result.missed.length) {
    result.findings.push({
      status: "fail",
      check,
      detail: `${result.missed.length} of ${all.length} mutants survived ${worlds.length} datasets; the differential would not notice these mistakes:\n${result.missed.map((m) => `    ${m.name}: ${m.description}`).join("\n")}`,
    });
  } else {
    result.findings.push({
      status: "ok",
      check,
      detail: `all ${all.length} mutants caught (${rls.mutants.length} RLS, ${sync.mutants.length} sync); ${result.equivalent.length} equivalent mutants skipped`,
    });
  }
  return result;
}
