import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { assertPowerSync, findSupabaseCli, parseEnv, stackFromStatus } from "./stack.ts";

const status = parseEnv(
  [
    'API_URL="http://127.0.0.1:54321"',
    'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
    'PUBLISHABLE_KEY="sb_publishable_x"',
    'SECRET_KEY="sb_secret_y"',
    "WARN: INBUCKET_URL is deprecated",
  ].join("\n"),
);

describe("stackFromStatus", () => {
  it("reads what supabase status -o env prints", () => {
    expect(stackFromStatus(status, "http://127.0.0.1:8080", { NODE_ENV: "test" })).toEqual({
      db: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      api: "http://127.0.0.1:54321",
      publishableKey: "sb_publishable_x",
      secretKey: "sb_secret_y",
      powersync: "http://127.0.0.1:8080",
    });
  });

  it("keeps the JWT secret when status prints one", () => {
    expect(stackFromStatus({ ...status, JWT_SECRET: "s3cret" }, "http://127.0.0.1:8080", { NODE_ENV: "test" }).jwtSecret).toBe("s3cret");
  });

  it("falls back to the legacy key names", () => {
    const legacy = { ...status, PUBLISHABLE_KEY: "", SECRET_KEY: "", ANON_KEY: "anon", SERVICE_ROLE_KEY: "service" };
    expect(stackFromStatus(legacy, "http://localhost:8080", { NODE_ENV: "test" })).toMatchObject({ publishableKey: "anon", secretKey: "service" });
  });

  it("refuses a stack that is not this machine, or a missing value", () => {
    expect(() => stackFromStatus(status, "https://powersync.example.com", { NODE_ENV: "test" })).toThrow(/PowerSync: powersync.example.com is not this machine; point --powersync at localhost/);
    expect(() => stackFromStatus({ ...status, API_URL: "https://abc.supabase.co" }, "http://127.0.0.1:8080", { NODE_ENV: "test" })).toThrow(/Supabase API: .*supabase start/);
    expect(() => stackFromStatus({ ...status, DB_URL: "" }, "http://127.0.0.1:8080", { NODE_ENV: "test" })).toThrow(
      "supabase status -o env prints no DB_URL; run supabase status to see what the CLI reports (is the stack running?)",
    );
    // Every key it lacks, at once.
    expect(() => stackFromStatus({ DB_URL: status.DB_URL as string }, "http://127.0.0.1:8080", { NODE_ENV: "test" })).toThrow(
      "prints no API_URL, PUBLISHABLE_KEY or ANON_KEY, SECRET_KEY or SERVICE_ROLE_KEY; run supabase status",
    );
  });
});

describe("findSupabaseCli", () => {
  it("takes the nearest node_modules/.bin/supabase above the project, else the PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "samesight-cli-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "apps", "web");
    mkdirSync(project, { recursive: true });
    expect(findSupabaseCli(project)).toBe("supabase");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "supabase"), "");
    expect(findSupabaseCli(project, "linux")).toBe(join(root, "node_modules", ".bin", "supabase"));
    expect(findSupabaseCli(project, "win32")).toBe("supabase");
  });
});

describe("assertPowerSync", () => {
  it("asks the readiness probe once, and says how to start a service that is not there", async () => {
    const asked: string[] = [];
    await assertPowerSync("http://127.0.0.1:8080/", async (url) => asked.push(url) > 0);
    expect(asked).toEqual(["http://127.0.0.1:8080"]);
    // Nothing listens on port 1.
    await expect(assertPowerSync("http://127.0.0.1:1")).rejects.toThrow(
      "PowerSync is not reachable at http://127.0.0.1:1; start it (docker compose up powersync) or pass --powersync <url>",
    );
    // Its address as shown, with no token from the query.
    await expect(assertPowerSync("http://127.0.0.1:1/?token=secret", async () => false)).rejects.toThrow(
      "PowerSync is not reachable at http://127.0.0.1:1/…; start it",
    );
  });
});
