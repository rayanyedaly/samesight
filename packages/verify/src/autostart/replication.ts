/**
 * What auto-start sets up in the project's local database for PowerSync to replicate
 * from, and removes afterwards: a login role with REPLICATION and BYPASSRLS (PowerSync's
 * initial snapshot reads the tables under RLS) that may only read the tables the sync
 * config reads, and the "powersync" publication if the project has none.
 *
 * Everything carries the run's name (samesight_audit_<run>), so teardown, and the sweep
 * of a run that died before it, touch nothing else: not the project's own roles, nor the
 * replication slots of a PowerSync it runs itself (powersync_...).
 */

import { randomBytes } from "node:crypto";
import type pg from "pg";

export const PREFIX = "samesight_audit_";
/** The publication PowerSync replicates; its name is fixed in the service. */
export const PUBLICATION = "powersync";

export interface Replication {
  run: string;
  role: string;
  password: string;
  /** PowerSync's replication slots for this run start with this. */
  slotPrefix: string;
  /** Whether this run created the publication, so teardown drops it. */
  createdPublication: boolean;
}

/** A run name: lowercase hex, safe in role, slot and container names. */
export function runName(): string {
  return randomBytes(4).toString("hex");
}

const comment = (run: string) => `samesight-verify audit ${run}; removed when the run ends`;

type Client = Pick<pg.Client, "query" | "escapeIdentifier" | "escapeLiteral">;

/** Creates the role and, when the project has none, the publication, for these public tables. */
export async function setUpReplication(client: Client, run: string, tables: string[]): Promise<Replication> {
  const role = `${PREFIX}${run}`;
  const password = randomBytes(24).toString("hex");
  const r: Replication = { run, role, password, slotPrefix: `${role}_`, createdPublication: false };
  const id = client.escapeIdentifier(role);
  const list = tables.map((t) => `public.${client.escapeIdentifier(t)}`).join(", ");
  await client.query(`create role ${id} with login replication bypassrls password ${client.escapeLiteral(password)}`);
  await client.query(`comment on role ${id} is ${client.escapeLiteral(comment(run))}`);
  await client.query(`grant usage on schema public to ${id}`);
  if (tables.length) await client.query(`grant select on ${list} to ${id}`);
  const { rows } = await client.query<{ exists: boolean }>("select exists (select from pg_publication where pubname = $1) as exists", [PUBLICATION]);
  if (!rows[0]?.exists && tables.length) {
    await client.query(`create publication ${PUBLICATION} for table ${list}`);
    await client.query(`comment on publication ${PUBLICATION} is ${client.escapeLiteral(comment(run))}`);
    r.createdPublication = true;
  }
  return r;
}

/**
 * Removes what setUpReplication created: the run's replication slots (ending any
 * replication still using them), the publication if it made it and it still carries the
 * run's mark, then the role. Safe to call twice, and on a run that only partly set up.
 */
export async function tearDownReplication(client: Client, r: Pick<Replication, "run" | "role" | "slotPrefix" | "createdPublication">): Promise<void> {
  await client.query("select pg_terminate_backend(active_pid) from pg_replication_slots where active and starts_with(slot_name, $1)", [r.slotPrefix]);
  await client.query("select pg_drop_replication_slot(slot_name) from pg_replication_slots where not active and starts_with(slot_name, $1)", [r.slotPrefix]);
  if (r.createdPublication) {
    const { rows } = await client.query<{ mark: string | null }>(
      "select obj_description(oid, 'pg_publication') as mark from pg_publication where pubname = $1",
      [PUBLICATION],
    );
    if (rows[0]?.mark === comment(r.run)) await client.query(`drop publication ${PUBLICATION}`);
  }
  const { rows: roles } = await client.query<{ exists: boolean }>("select exists (select from pg_roles where rolname = $1) as exists", [r.role]);
  if (roles[0]?.exists) {
    const id = client.escapeIdentifier(r.role);
    await client.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = $1", [r.role]);
    // Its grants, revoked one by one: drop owned would need membership in the role.
    await client.query(`revoke all on all tables in schema public from ${id}`);
    await client.query(`revoke all on schema public from ${id}`);
    await client.query(`drop role ${id}`);
  }
}
