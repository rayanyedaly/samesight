import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { type ContainerInfo, findSupabase, projectId } from "./project.ts";

describe("projectId", () => {
  it("reads the top-level project_id, quoted either way, and nothing under a section", () => {
    expect(projectId('# A comment\nproject_id = "react-supabase-todolist"\n\n[api]\nport = 54321\n')).toBe("react-supabase-todolist");
    expect(projectId("project_id = 'quickstart' # trailing\n")).toBe("quickstart");
    expect(projectId('[api]\nproject_id = "nested"\n')).toBeUndefined();
    expect(projectId("")).toBeUndefined();
  });
});

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A project directory with a supabase/config.toml. */
function project(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-project-"));
  temps.push(dir);
  mkdirSync(join(dir, "supabase"));
  writeFileSync(join(dir, "supabase", "config.toml"), `project_id = "${id}"\n`);
  return dir;
}

const container = (name: string, image: string, labels: Record<string, string>, networks: string[], running = true): ContainerInfo => ({
  Name: `/${name}`,
  Config: { Image: image, Labels: labels },
  State: { Running: running },
  NetworkSettings: {
    Networks: Object.fromEntries(networks.map((n) => [n, {}])),
    Ports: name.startsWith("supabase_db_") ? { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54322" }] } : {},
  },
});

/** A fake docker holding these containers. */
function docker(containers: ContainerInfo[]): Docker {
  const exec: Exec = async (args) => {
    if (args[0] === "ps") return { stdout: containers.map((c) => c.Name.slice(1)).join("\n"), stderr: "" };
    const found = containers.find((c) => c.Name === `/${args[2]}`);
    if (!found) throw Object.assign(new Error("failed"), { stderr: `Error: No such container: ${args[2]}` });
    return { stdout: JSON.stringify([found]), stderr: "" };
  };
  return new Docker(exec);
}

const stack = (id: string, workdir: string, running = true) => [
  container(`supabase_db_${id}`, "public.ecr.aws/supabase/postgres:17.6.1.035", { "com.supabase.cli.project": id, "com.supabase.cli.workdir": workdir }, [`supabase_network_${id}`], running),
  container(`supabase_kong_${id}`, "public.ecr.aws/supabase/kong:2.8.1", { "com.supabase.cli.project": id, "com.supabase.cli.workdir": workdir }, [`supabase_network_${id}`]),
  container(`supabase_auth_${id}`, "public.ecr.aws/supabase/gotrue:v2.1", { "com.supabase.cli.project": id, "com.supabase.cli.workdir": workdir }, [`supabase_network_${id}`]),
];

describe("findSupabase", () => {
  it("finds the project's database, gateway and network by its labels", async () => {
    const dir = project("todo");
    expect(await findSupabase(docker([...stack("other", "/elsewhere"), ...stack("todo", dir)]), dir)).toEqual({
      project: "todo",
      db: "supabase_db_todo",
      kong: "supabase_kong_todo",
      network: "supabase_network_todo",
    });
  });

  it("prefers the copy started from this directory when two share a project_id", async () => {
    const dir = project("todo");
    const copy = stack("todo", "/a/copy").map((c) => ({ ...c, Name: `${c.Name}_copy`, NetworkSettings: { Networks: { copy_net: {} } } }));
    expect(await findSupabase(docker([...copy, ...stack("todo", dir)]), dir)).toMatchObject({ db: "supabase_db_todo", network: "supabase_network_todo" });
  });

  it("says where to add a missing project_id", async () => {
    const dir = project("todo");
    writeFileSync(join(dir, "supabase", "config.toml"), "[api]\nport = 54321\n");
    await expect(findSupabase(docker(stack("todo", dir)), dir)).rejects.toThrow(
      `${join(dir, "supabase", "config.toml")} has no project_id; add project_id = "..." at the top of supabase/config.toml (supabase init writes it)`,
    );
  });

  it("falls back to the project_id label when no container names this directory", async () => {
    const dir = project("todo");
    expect(await findSupabase(docker(stack("todo", "/moved/since")), dir)).toMatchObject({ db: "supabase_db_todo" });
  });

  it("checks the database container publishes the port the audit reaches the database at", async () => {
    const dir = project("todo");
    expect(await findSupabase(docker(stack("todo", dir)), dir, 54322)).toMatchObject({ db: "supabase_db_todo" });
    await expect(findSupabase(docker(stack("todo", dir)), dir, 5432)).rejects.toThrow(/supabase_db_todo does not publish port 5432.*DOCKER_HOST/);
  });

  it("says to run supabase start when the stack is down, and names a missing config", async () => {
    const dir = project("todo");
    await expect(findSupabase(docker([]), dir)).rejects.toThrow(/project todo\) is not running; run supabase start/);
    await expect(findSupabase(docker(stack("todo", dir, false)), dir)).rejects.toThrow(/not running/);
    await expect(findSupabase(docker([]), join(dir, "nowhere"))).rejects.toThrow(/no supabase\/config.toml in .*pass --project/);
  });
});
