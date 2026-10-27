import { describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { POSTGRES_IMAGE, removeContainers, startStorage } from "./storage.ts";

/** A fake docker whose pg_isready fails `notReady` times before it answers. */
function fake(notReady: number, rmError?: string) {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  let left = notReady;
  const exec: Exec = async (args, env) => {
    calls.push(args);
    envs.push(env);
    if (args[0] === "exec" && left-- > 0) throw Object.assign(new Error("failed"), { stderr: "127.0.0.1:5432 - no response" });
    if (args[0] === "rm" && rmError) throw Object.assign(new Error("failed"), { stderr: rmError });
    if (args[0] === "logs") return { stdout: "database system is starting up", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { docker: new Docker(exec), calls, envs };
}

describe("startStorage", () => {
  it("runs the pinned Postgres on the network, labelled, on a tmpfs, and waits for TCP", async () => {
    const { docker, calls, envs } = fake(2);
    const s = await startStorage(docker, "a1b2c3d4", "todo", "supabase_network_todo");
    expect(s.container).toBe("samesight-audit-a1b2c3d4-storage");
    expect(s.uri).toMatch(/^postgresql:\/\/powersync_storage:[0-9a-f]{48}@samesight-audit-a1b2c3d4-storage:5432\/powersync_storage$/);
    const run = calls[0] as string[];
    expect(run.slice(0, 13)).toEqual([
      "run",
      "--detach",
      "--name",
      "samesight-audit-a1b2c3d4-storage",
      "--label",
      "dev.samesight.audit.run=a1b2c3d4",
      "--label",
      "dev.samesight.audit.project=todo",
      "--network",
      "supabase_network_todo",
      "--tmpfs",
      "/var/lib/postgresql",
      "--env",
    ]);
    expect(run.at(-1)).toBe(POSTGRES_IMAGE);
    // The password is in docker's environment, not on its command line.
    expect(run).toContain("POSTGRES_PASSWORD");
    expect(run.join(" ")).not.toMatch(/POSTGRES_PASSWORD=/);
    expect(s.uri).toContain(envs[0]?.POSTGRES_PASSWORD as string);
    expect(run).not.toContain("--publish");
    expect(calls.filter((c) => c[0] === "exec")).toHaveLength(3);
    expect(calls[1]).toContain("127.0.0.1");
  });

  it("gives up with the container's last log lines", async () => {
    const { docker } = fake(Number.POSITIVE_INFINITY);
    await expect(startStorage(docker, "a1b2c3d4", "todo", "net", 600)).rejects.toThrow(/did not start within 0.6s:\ndatabase system is starting up/);
  });
});

describe("removeContainers", () => {
  it("removes containers with their volumes, and takes a missing one as done", async () => {
    const { docker, calls } = fake(0);
    await removeContainers(docker, ["a", "b"]);
    expect(calls).toEqual([["rm", "--force", "--volumes", "a", "b"]]);
    await removeContainers(fake(0, "Error response from daemon: No such container: a").docker, ["a"]);
    await expect(removeContainers(fake(0, "Error response from daemon: dial unix /var/run/docker.sock: connect: no such file").docker, ["a"])).rejects.toThrow(/docker rm failed/);
  });
});

describe("removeContainers, while another process removes them", () => {
  it("waits until they are gone", async () => {
    let listed = 2;
    const exec: Exec = async (args) => {
      if (args[0] === "rm") throw Object.assign(new Error("failed"), { stderr: "Error response from daemon: removal of container x is already in progress" });
      if (args[0] === "ps") return { stdout: listed-- > 0 ? "x" : "", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await removeContainers(new Docker(exec), ["x"]);
    expect(listed).toBe(-1);
  });
});
