import { describe, expect, it } from "vitest";
import { Docker, DockerError, type Exec } from "./docker.ts";

/** A fake docker: answers by the first argument, or fails the way the real CLI does. */
function fake(answers: Record<string, string | Error>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    const answer = answers[args.slice(0, 2).join(" ")] ?? answers[args[0] ?? ""];
    if (answer instanceof Error) throw answer;
    return { stdout: answer ?? "", stderr: "" };
  };
  return { exec, calls };
}

const failure = (stderr: string, code?: string) => Object.assign(new Error("Command failed"), { stderr, ...(code ? { code } : {}) });

describe("Docker", () => {
  it("says to install Docker when there is no docker command", async () => {
    const docker = new Docker(fake({ version: failure("", "ENOENT") }).exec);
    await expect(docker.check()).rejects.toThrow(/Docker is not installed .*pass --powersync <url>/);
  });

  it("says to start Docker when the daemon does not answer", async () => {
    for (const stderr of [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      "error during connect: Get \"http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.47/version\": open //./pipe/docker_engine: The system cannot find the file specified.",
    ]) {
      const docker = new Docker(fake({ version: failure(stderr) }).exec);
      await expect(docker.check(), stderr).rejects.toThrow(/installed but not running; start Docker Desktop/);
    }
  });

  it("says when the socket refuses this user", async () => {
    const docker = new Docker(fake({ version: failure("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock") }).exec);
    await expect(docker.check()).rejects.toThrow(/permission denied on its socket/);
  });

  it("names the command and its last error line otherwise", async () => {
    const docker = new Docker(fake({ run: failure("Unable to find image\ndocker: Error response from daemon: pull access denied.") }).exec);
    const e = await docker.run(["run", "x"]).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DockerError);
    expect((e as Error).message).toBe("docker run failed: docker: Error response from daemon: pull access denied.");
  });

  it("inspects one object, and reads a missing one as null", async () => {
    const docker = new Docker(
      fake({
        "container inspect": JSON.stringify([{ Name: "/db" }]),
        "network inspect": failure("Error response from daemon: network supabase_network_x not found"),
        "image inspect": failure("Error: No such image: journeyapps/powersync-service"),
      }).exec,
    );
    expect(await docker.inspect("container", "db")).toEqual({ Name: "/db" });
    expect(await docker.inspect("network", "supabase_network_x")).toBeNull();
    expect(await docker.inspect("image", "journeyapps/powersync-service")).toBeNull();
  });

  it("still explains a daemon that is down while inspecting", async () => {
    const docker = new Docker(fake({ "container inspect": failure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.") }).exec);
    await expect(docker.inspect("container", "db")).rejects.toThrow(/not running/);
  });

  it("lists matching containers by filter", async () => {
    const { exec, calls } = fake({ ps: "samesight-audit-a1-powersync\nsamesight-audit-a1-storage\n" });
    expect(await new Docker(exec).containers(["label=dev.samesight.audit.run=a1"])).toEqual(["samesight-audit-a1-powersync", "samesight-audit-a1-storage"]);
    expect(calls[0]).toEqual(["ps", "--all", "--no-trunc", "--filter", "label=dev.samesight.audit.run=a1", "--format", "{{.Names}}"]);
  });
});
