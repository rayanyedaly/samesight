/**
 * Docker, as audit's auto-start uses it: the `docker` CLI on the PATH, run without a shell.
 * Every error says what to do next: install Docker, start it, or pass --powersync to audit
 * against a PowerSync service run some other way.
 */

import { spawn } from "node:child_process";

/**
 * Runs `docker` with these arguments; rejects with the process error, stdout and stderr
 * attached. `env` is added to docker's own environment: a secret passed as `--env NAME`
 * with its value there never shows on a command line other users can list.
 */
export type Exec = (args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>;

export const execDocker: Exec = (args, env) =>
  new Promise((resolve, reject) => {
    // In a process group of its own (not on Windows, where that means a console of its own):
    // a Ctrl+C typed at the terminal is the CLI's to handle, never cutting a docker call short.
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => reject(Object.assign(err, { stdout, stderr })));
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`docker ${args[0] ?? ""} exited ${code ?? signal}`), { stdout, stderr }));
    });
  });

/** Runs `docker` with its output shown on stderr as it comes (an image pull's progress). */
export function streamDocker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", 2, 2], windowsHide: true });
    child.on("error", (e) => reject(explain(args, e)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new DockerError(`docker ${args[0]} failed (exit ${code})`))));
  });
}

export class DockerError extends Error {}

const FALLBACK = "or pass --powersync <url> to audit against a PowerSync service you run yourself";

/** What a failed `docker` call means for the user, from its error and stderr. */
export function explain(args: string[], e: unknown): DockerError {
  const err = e as NodeJS.ErrnoException & { stderr?: string };
  if (err.code === "ENOENT") return new DockerError(`Docker is not installed (no docker command on the PATH); install Docker, ${FALLBACK}`);
  const stderr = (err.stderr ?? "").trim();
  if (/permission denied/i.test(stderr) && /docker\.sock|daemon/i.test(stderr)) {
    return new DockerError(`Docker refused this user (permission denied on its socket); add the user to the docker group, ${FALLBACK}`);
  }
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|docker_engine/i.test(stderr)) {
    return new DockerError(`Docker is installed but not running; start Docker Desktop or the Docker service, ${FALLBACK}`);
  }
  const detail = stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? (err.message || "failed");
  return new DockerError(`docker ${args[0] ?? ""} failed: ${detail}`);
}

export class Docker {
  private readonly exec: Exec;

  constructor(exec: Exec = execDocker) {
    this.exec = exec;
  }

  /** Runs docker and returns its trimmed stdout, or throws a DockerError that says what to do. */
  async run(args: string[], env?: Record<string, string>): Promise<string> {
    try {
      return (await this.exec(args, env)).stdout.trim();
    } catch (e) {
      throw explain(args, e);
    }
  }

  /** A container's last log lines: those of its stdout, then those of its stderr. */
  async logs(container: string, tail: number): Promise<string> {
    try {
      const { stdout, stderr } = await this.exec(["logs", "--tail", String(tail), container]);
      return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    } catch (e) {
      throw explain(["logs"], e);
    }
  }

  /** Throws unless the Docker CLI is installed and its daemon answers. */
  async check(): Promise<void> {
    await this.run(["version", "--format", "{{.Server.Version}}"]);
  }

  /** The `docker inspect` object for a container, network or image; null when there is none. */
  async inspect<T>(kind: "container" | "network" | "image", name: string): Promise<T | null> {
    try {
      const [first] = JSON.parse((await this.exec([kind, "inspect", name])).stdout) as T[];
      return first ?? null;
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr ?? "";
      if (/no such (container|network|image|object)|not found/i.test(stderr)) return null;
      throw explain([kind, "inspect"], e);
    }
  }

  /** Names of the containers, running or not, that match every filter (label=..., name=...). */
  async containers(filters: string[]): Promise<string[]> {
    const out = await this.run(["ps", "--all", "--no-trunc", ...filters.flatMap((f) => ["--filter", f]), "--format", "{{.Names}}"]);
    return out.split(/\r?\n/).filter(Boolean);
  }
}
