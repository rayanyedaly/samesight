/**
 * Before a run starts, it removes what an earlier run on the same project left behind when
 * it was killed outright: its containers (by the project label), then, in the project's
 * database, every samesight_audit_ role (ending the sessions of the PowerSync just
 * removed), the publication such a run created, and samesight_audit_ replication slots.
 * A slot held open would keep the database's write-ahead log growing; nothing outside this
 * naming is touched. Each project has a database of its own, and two audits of one
 * project at once are not supported, so every such role here is a dead run's.
 */

import type pg from "pg";
import type { Docker } from "./docker.ts";
import { PREFIX, PUBLICATION, tearDownReplication } from "./replication.ts";
import { PROJECT_LABEL, removeContainers } from "./storage.ts";

type Client = Pick<pg.Client, "query" | "escapeIdentifier" | "escapeLiteral">;

/** Removes an earlier run's leftovers; resolves with what it removed, for the log. */
export async function sweep(docker: Docker, client: Client, project: string): Promise<string[]> {
  const removed: string[] = [];
  const containers = await docker.containers([`label=${PROJECT_LABEL}=${project}`]);
  if (containers.length) {
    await removeContainers(docker, containers);
    removed.push(...containers);
  }
  const { rows: roles } = await client.query<{ role: string }>("select rolname as role from pg_roles where starts_with(rolname, $1)", [PREFIX]);
  for (const { role } of roles) {
    // createdPublication: teardown drops the publication only if it carries this run's mark.
    await tearDownReplication(client, { run: role.slice(PREFIX.length), role, slotPrefix: `${role}_`, createdPublication: true });
    removed.push(role);
  }
  const { rows: slots } = await client.query<{ slot: string }>(
    "select slot_name as slot from pg_replication_slots where not active and starts_with(slot_name, $1)",
    [PREFIX],
  );
  for (const { slot } of slots) {
    await client.query("select pg_drop_replication_slot($1)", [slot]);
    removed.push(slot);
  }
  // A publication a run made, whose role is gone: the run died between the two.
  const { rows: pubs } = await client.query<{ mark: string | null }>("select obj_description(oid, 'pg_publication') as mark from pg_publication where pubname = $1", [
    PUBLICATION,
  ]);
  const run = /^samesight-verify audit ([0-9a-f]+);/.exec(pubs[0]?.mark ?? "")?.[1];
  if (run) {
    const { rows: alive } = await client.query<{ alive: boolean }>("select exists (select from pg_roles where rolname = $1) as alive", [`${PREFIX}${run}`]);
    if (!alive[0]?.alive) {
      await client.query(`drop publication ${PUBLICATION}`);
      removed.push(`publication ${PUBLICATION}`);
    }
  }
  return removed;
}
