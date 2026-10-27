/**
 * Before a run starts, it removes what an earlier run on the same project left behind when
 * it was killed outright: its containers (by the project label), then, in the project's
 * database, every samesight_audit_ role (ending the sessions of the PowerSync just
 * removed) and samesight_audit_ replication slot. A slot left behind would keep the
 * database's write-ahead log growing; nothing outside this naming is touched. Each
 * project has a database of its own, and auto-start holds a lock on it from before the
 * sweep until its run ends, so every such role here is a dead run's.
 */

import type pg from "pg";
import type { Docker } from "./docker.ts";
import { PREFIX, tearDownReplication } from "./replication.ts";
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
    await tearDownReplication(client, { role, slotPrefix: `${role}_` });
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
  return removed;
}
