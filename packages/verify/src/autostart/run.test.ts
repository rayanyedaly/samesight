import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docker, type Exec } from "./docker.ts";
import { autoStart, KEEP_LABEL } from "./run.ts";
import type { Signals } from "./teardown.ts";

/** A PowerSync stand-in, always ready, with no JWKS (so tokens are checked with the secret). */
let server: Server;
let url: string;
/** A project directory whose supabase/config.toml names project "todo". */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "samesight-autostart-"));
  mkdirSync(join(dir, "supabase"));
  writeFileSync(join(dir, "supabase", "config.toml"), 'project_id = "todo"\n');
  server = createServer((req, res) => {
    res.statusCode = req.url === "/probes/readiness" ? 200 : 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const supabase = (name: string, image: string) => ({
  Name: `/${name}`,
  Config: { Image: image, Labels: { "com.supabase.cli.project": "todo" } },
  State: { Running: true },
  NetworkSettings: { Networks: { supabase_network_todo: {} }, Ports: name.startsWith("supabase_db") ? { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54322" }] } : {} },
});

/** A fake Docker with the demo's Supabase stack, optionally a kept run, recording calls. */
function docker(o: { kept?: string; failOn?: RegExp } = {}) {
  const calls: string[][] = [];
  const containers: Record<string, unknown> = {
    supabase_db_todo: supabase("supabase_db_todo", "supabase/postgres:17"),
    supabase_kong_todo: supabase("supabase_kong_todo", "supabase/kong:2.8"),
  };
  const exec: Exec = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    if (o.failOn?.test(line)) throw Object.assign(new Error("failed"), { stderr: "Error: no space left on device" });
    const out = (stdout: string) => ({ stdout, stderr: "" });
    if (args[0] === "ps") {
      if (line.includes("label=com.supabase.cli.project")) return out("supabase_db_todo\nsupabase_kong_todo");
      if (o.kept && line.includes(KEEP_LABEL)) return out(`samesight-audit-${o.kept}-powersync`);
      if (o.kept && line.includes(`name=^samesight-audit-${o.kept}-storage$`)) return out(`samesight-audit-${o.kept}-storage`);
      if (o.kept && line.includes("label=dev.samesight.audit.project=todo")) return out(`samesight-audit-${o.kept}-powersync\nsamesight-audit-${o.kept}-storage`);
      return out("");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const name = args[2] as string;
      if (o.kept && name === `samesight-audit-${o.kept}-powersync`) return out(JSON.stringify([{ Config: { Labels: { "dev.samesight.audit.run": o.kept } } }]));
      if (name in containers) return out(JSON.stringify([containers[name]]));
      if (name.startsWith("samesight-audit-")) return out(JSON.stringify([{ State: { Running: true } }]));
      throw Object.assign(new Error("failed"), { stderr: `Error: No such container: ${name}` });
    }
    if (args[0] === "image") return out(JSON.stringify([{ Id: "sha256:1" }]));
    if (args[0] === "port") return out(url.replace("http://", ""));
    if (args[0] === "logs") return out("the last words");
    return out("");
  };
  return { docker: new Docker(exec), calls, ran: () => calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]) };
}

/** A fake database connection: the advisory lock, the kept run's role and slot, recording statements. */
function db(o: { locked?: boolean; keptAlive?: boolean } = {}) {
  const sql: string[] = [];
  return {
    sql,
    escapeIdentifier: (s: string) => `"${s}"`,
    escapeLiteral: (s: string) => `'${s}'`,
    query: (async (text: string) => {
      sql.push(text);
      if (/pg_try_advisory_lock/.test(text)) return { rows: [{ ok: !o.locked }] };
      if (/as ok/.test(text)) return { rows: [{ ok: o.keptAlive ?? false }] };
      if (/exists \(select from pg_roles/.test(text)) return { rows: [{ exists: true }] };
      return { rows: [] };
    }) as never,
  };
}

/** A process stand-in that only counts signal listeners. */
function proc() {
  return Object.assign(new EventEmitter(), { exit: () => undefined as never }) as unknown as Signals & EventEmitter;
}
const listening = (p: EventEmitter) => ["SIGINT", "SIGTERM", "SIGHUP"].reduce((n, s) => n + p.listenerCount(s), 0);

const options = (d: Docker, c: ReturnType<typeof db>, p: Signals, keep = false) => ({
  projectDir: dir,
  client: c,
  dbPort: 54322,
  api: url,
  jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
  syncConfig: "streams: {}",
  tables: ["todos", "lists"],
  log: () => {},
  keep,
  docker: d,
  proc: p,
});

describe("autoStart", () => {
  it("starts storage and PowerSync, and on stop removes them, the role, the lock and its signal handlers", async () => {
    const d = docker();
    const c = db();
    const p = proc();
    const started = await autoStart(options(d.docker, c, p));
    expect(started).toMatchObject({ url, version: "1.27.2", reused: false, slotPrefix: expect.stringMatching(/^samesight_audit_[0-9a-f]{8}_$/) });
    expect(d.ran()).toEqual([expect.stringMatching(/-storage$/), expect.stringMatching(/-powersync$/)]);
    expect(listening(p)).toBe(3);
    const logs: string[] = [];
    expect(await started.stop({ logs: (t) => logs.push(t) })).toEqual([]);
    expect(logs).toEqual(["the last words"]);
    expect(d.calls.find((c) => c[0] === "rm")).toEqual(["rm", "--force", "--volumes", ...d.ran()]);
    expect(c.sql.some((s) => /^drop role "samesight_audit_/.test(s))).toBe(true);
    expect(c.sql.at(-1)).toBe("select pg_advisory_unlock($1)");
    expect(listening(p)).toBe(0);
  });

  it("removes what it made when a step fails half way", async () => {
    const d = docker({ failOn: /^run .*-powersync/ });
    const c = db();
    const p = proc();
    await expect(autoStart(options(d.docker, c, p))).rejects.toThrow(/no space left on device/);
    expect(d.calls.find((c) => c[0] === "rm")?.slice(3)).toEqual([expect.stringMatching(/-storage$/), expect.stringMatching(/-powersync$/)]);
    expect(c.sql.some((s) => /^drop role/.test(s))).toBe(true);
    expect(c.sql.at(-1)).toBe("select pg_advisory_unlock($1)");
    expect(listening(p)).toBe(0);
  });

  it("refuses to start while another audit holds the database, creating nothing", async () => {
    const d = docker();
    const c = db({ locked: true });
    await expect(autoStart(options(d.docker, c, proc()))).rejects.toThrow(/another samesight-verify audit is running PowerSync/);
    expect(d.ran()).toEqual([]);
    expect(c.sql.some((s) => /create role|drop role/.test(s))).toBe(false);
  });

  it("with keep, labels the service and leaves it up, letting go of the lock and the signals", async () => {
    const d = docker();
    const c = db();
    const p = proc();
    const started = await autoStart(options(d.docker, c, p, true));
    const run = d.calls.find((c) => c[0] === "run" && c.some((a) => a.endsWith("-powersync"))) ?? [];
    expect(run.find((a) => a.startsWith(`${KEEP_LABEL}=`))).toMatch(/=[0-9a-f]{16}$/);
    expect(listening(p)).toBe(0);
    expect(await started.stop()).toEqual([]);
    expect(d.calls.some((c) => c[0] === "rm")).toBe(false);
    expect(c.sql.some((s) => /drop role/.test(s))).toBe(false);
    expect(c.sql.at(-1)).toBe("select pg_advisory_unlock($1)");
  });

  it("reuses a kept service whose replication is alive, and removes it at the end of a run without keep", async () => {
    const d = docker({ kept: "0a0b0c0d" });
    const c = db({ keptAlive: true });
    const started = await autoStart(options(d.docker, c, proc()));
    expect(started).toMatchObject({ url, reused: true, slotPrefix: "samesight_audit_0a0b0c0d_" });
    expect(d.ran()).toEqual([]);
    await started.stop();
    expect(d.calls.find((c) => c[0] === "rm")).toEqual(["rm", "--force", "--volumes", "samesight-audit-0a0b0c0d-storage", "samesight-audit-0a0b0c0d-powersync"]);
    expect(c.sql).toContain('drop role "samesight_audit_0a0b0c0d"');
  });

  it("sweeps a kept service whose database was reset, and starts afresh", async () => {
    const d = docker({ kept: "0a0b0c0d" });
    const started = await autoStart(options(d.docker, db({ keptAlive: false }), proc()));
    expect(started.reused).toBe(false);
    expect(d.calls.find((c) => c[0] === "rm")).toEqual(["rm", "--force", "--volumes", "samesight-audit-0a0b0c0d-powersync", "samesight-audit-0a0b0c0d-storage"]);
    expect(d.ran()).toHaveLength(2);
    await started.stop();
  });
});
