/**
 * What auto-start sets up in the project's local database for PowerSync to replicate
 * from, and removes afterwards: a login role with REPLICATION and BYPASSRLS (PowerSync's
 * initial snapshot reads the tables under RLS). It is granted SELECT only on the tables
 * the sync config reads, but REPLICATION lets it stream every change to the database
 * through the project's "powersync" publication, which the audit has checked is there:
 * so its password is random, never shown, and it lives only as long as the run.
 *
 * Everything carries the run's name (samesight_audit_<run>), so teardown, and the sweep
 * of a run that died before it, touch nothing else: not the project's own roles, nor the
 * replication slots of a PowerSync it runs itself (powersync_...).
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type pg from "pg";

export const PREFIX = "samesight_audit_";

export interface Replication {
  run: string;
  role: string;
  password: string;
  /** PowerSync's replication slots for this run start with this. */
  slotPrefix: string;
}

/** A run name: lowercase hex, safe in role, slot and container names. */
export function runName(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The password as Postgres stores it (SCRAM-SHA-256), so the plain text never reaches the
 * server, nor its log when log_statement records DDL or the statement fails.
 */
export function scramVerifier(password: string, salt = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const key = (name: string) => createHmac("sha256", salted).update(name).digest();
  const stored = createHash("sha256").update(key("Client Key")).digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored.toString("base64")}:${key("Server Key").toString("base64")}`;
}

const comment = (run: string) => `samesight-verify audit ${run}; removed when the run ends`;

type Client = Pick<pg.Client, "query" | "escapeIdentifier" | "escapeLiteral">;

/** Creates the role, reading these public tables. */
export async function setUpReplication(client: Client, run: string, tables: string[]): Promise<Replication> {
  const role = `${PREFIX}${run}`;
  const password = randomBytes(24).toString("hex");
  const r: Replication = { run, role, password, slotPrefix: `${role}_` };
  const id = client.escapeIdentifier(role);
  const list = tables.map((t) => `public.${client.escapeIdentifier(t)}`).join(", ");
  await client.query(`create role ${id} with login replication bypassrls password ${client.escapeLiteral(scramVerifier(password))}`);
  await client.query(`comment on role ${id} is ${client.escapeLiteral(comment(run))}`);
  await client.query(`grant usage on schema public to ${id}`);
  if (tables.length) await client.query(`grant select on ${list} to ${id}`);
  return r;
}

/**
 * Removes what setUpReplication created: the run's replication slots (ending any
 * replication still using them), then the role. Safe to call twice, and on a run that
 * only partly set up.
 */
export async function tearDownReplication(client: Client, r: Pick<Replication, "role" | "slotPrefix">): Promise<void> {
  // Waits (up to 5s each) for the replication to end, so its slot is inactive when dropped.
  await client.query("select pg_terminate_backend(active_pid, 5000) from pg_replication_slots where active and starts_with(slot_name, $1)", [r.slotPrefix]);
  await client.query("select pg_drop_replication_slot(slot_name) from pg_replication_slots where not active and starts_with(slot_name, $1)", [r.slotPrefix]);
  const { rows: roles } = await client.query<{ exists: boolean }>("select exists (select from pg_roles where rolname = $1) as exists", [r.role]);
  if (roles[0]?.exists) {
    const id = client.escapeIdentifier(r.role);
    await client.query("select pg_terminate_backend(pid, 5000) from pg_stat_activity where usename = $1", [r.role]);
    // Its grants, revoked one by one: drop owned would need membership in the role.
    await client.query(`revoke all on all tables in schema public from ${id}`);
    await client.query(`revoke all on schema public from ${id}`);
    await client.query(`drop role ${id}`);
  }
}
