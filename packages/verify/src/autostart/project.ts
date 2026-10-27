/**
 * The project's running Supabase stack, as Docker sees it: its database and API gateway
 * containers and the network they share, which auto-start joins. Found by the labels the
 * Supabase CLI puts on its containers (the project's directory, then its project_id),
 * not by container names alone, which the CLI could change.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Docker } from "./docker.ts";

export interface SupabaseStack {
  /** The project_id in supabase/config.toml. */
  project: string;
  /** The database container's name, which is also its host name on the network. */
  db: string;
  /** The API gateway (Kong) container's name. */
  kong: string;
  /** The network both are on, which the PowerSync and storage containers join. */
  network: string;
}

/** The top-level project_id in a supabase/config.toml. */
export function projectId(toml: string): string | undefined {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return undefined;
    const m = /^\s*project_id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

/** What `docker container inspect` says, as far as this file reads it. */
export interface ContainerInfo {
  Name: string;
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Running: boolean };
  NetworkSettings: { Networks: Record<string, unknown> | null };
}

const PROJECT = "com.supabase.cli.project";
const WORKDIR = "com.supabase.cli.workdir";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const isDb = (c: ContainerInfo) => /(^|\/)supabase\/postgres(:|@|$)/.test(c.Config.Image) || /^\/?supabase_db_/.test(c.Name);
const isKong = (c: ContainerInfo) => /(^|\/)kong(:|@|$)/.test(c.Config.Image) || /^\/?supabase_kong_/.test(c.Name);
const name = (c: ContainerInfo) => c.Name.replace(/^\//, "");

/** Finds the running Supabase stack of the project in `projectDir` (the directory holding supabase/). */
export async function findSupabase(docker: Docker, projectDir: string): Promise<SupabaseStack> {
  const configPath = join(projectDir, "supabase", "config.toml");
  if (!existsSync(configPath)) throw new Error(`no supabase/config.toml in ${resolve(projectDir)}; pass --project with the directory that holds supabase/`);
  const project = projectId(readFileSync(configPath, "utf8"));
  if (!project) throw new Error(`${configPath} has no project_id`);

  const names = await docker.containers([`label=${PROJECT}`]);
  const all = (await Promise.all(names.map((n) => docker.inspect<ContainerInfo>("container", n)))).filter((c): c is ContainerInfo => c !== null);
  // The directory label names this very project; the project_id could be shared by two copies.
  const dir = real(projectDir);
  const byDir = all.filter((c) => c.Config.Labels?.[WORKDIR] !== undefined && real(c.Config.Labels[WORKDIR] as string) === dir);
  const mine = byDir.length ? byDir : all.filter((c) => c.Config.Labels?.[PROJECT] === project);

  const db = mine.find(isDb);
  const kong = mine.find(isKong);
  if (!db?.State.Running || !kong?.State.Running) {
    throw new Error(`the Supabase stack of ${resolve(projectDir)} (project ${project}) is not running; run supabase start there first`);
  }
  const shared = Object.keys(db.NetworkSettings.Networks ?? {}).filter((n) => n in (kong.NetworkSettings.Networks ?? {}));
  const network = shared.find((n) => n.startsWith("supabase_network_")) ?? shared[0];
  if (!network) throw new Error(`the Supabase containers of project ${project} share no Docker network`);
  return { project, db: name(db), kong: name(kong), network };
}
