import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { fieldbookPolicy, fieldbookSchema } from "./fixtures/fieldbook.ts";
import { nextVersion, outputPaths, plan } from "./generate.ts";
import { assertLocal, DEFAULT_DB_URL, projectDbUrl } from "./introspect.ts";
import { definePolicy, isPolicy } from "./policy.ts";

describe("assertLocal", () => {
  it("accepts only this machine", () => {
    expect(() => assertLocal("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).not.toThrow();
    expect(() => assertLocal("postgresql://u:p@localhost/db")).not.toThrow();
    expect(() => assertLocal("postgresql://u:p@[::1]:5432/db")).not.toThrow();
    expect(() => assertLocal("postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres")).toThrow(/only connects to a local database/);
    expect(() => assertLocal("postgresql://u:p@127.0.0.1.evil.example/db")).toThrow(/only connects/);
    expect(() => assertLocal("not a url")).toThrow(/not a valid/);
  });

  it("refuses a query parameter that would make pg connect elsewhere, and other schemes", () => {
    expect(() => assertLocal("postgresql://u:p@127.0.0.1/db?host=db.example.supabase.co")).toThrow(/cannot set host/);
    expect(() => assertLocal("postgresql://u:p@localhost/db?hostaddr=10.0.0.1")).toThrow(/cannot set hostaddr/);
    expect(() => assertLocal("postgresql:///db?host=remote")).toThrow(/cannot set host/);
    expect(() => assertLocal("postgresql:///db")).toThrow(/an empty host/);
    expect(() => assertLocal("http://localhost/db")).toThrow(/must start with postgres/);
  });
});

describe("projectDbUrl", () => {
  it("reads the [db] port from supabase/config.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-db-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    expect(projectDbUrl(dir)).toBe(DEFAULT_DB_URL);
    mkdirSync(join(dir, "supabase"));
    writeFileSync(join(dir, "supabase", "config.toml"), '[api]\nport = 56321\n\n[db]\n# The port\nport = 56322 # local\nshadow_port = 56320\n');
    expect(projectDbUrl(dir)).toBe("postgresql://postgres:postgres@127.0.0.1:56322/postgres");
    writeFileSync(join(dir, "supabase", "config.toml"), "[api]\nport = 56321\n");
    expect(projectDbUrl(dir)).toBe(DEFAULT_DB_URL);
  });
});

describe("nextVersion", () => {
  const now = new Date("2026-10-25T20:00:00Z");
  it("uses the clock when it is after every migration", () => {
    expect(nextVersion("20261025170100", now)).toBe("20261025200000");
    expect(nextVersion(undefined, now)).toBe("20261025200000");
  });
  it("lands one second after a migration dated in the future", () => {
    expect(nextVersion("20261026090000", now)).toBe("20261026090001");
    expect(nextVersion("20261231235959", now)).toBe("20270101000000");
  });
  it("refuses a newest version it cannot step past", () => {
    expect(() => nextVersion("99999999999999", now)).toThrow(/cannot find a migration version/);
  });
});

describe("plan", () => {
  const root = mkdtempSync(join(tmpdir(), "samesight-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const now = new Date("2026-10-25T20:00:00Z");

  it("writes a new migration only when the output changes", () => {
    const first = plan(fieldbookPolicy, fieldbookSchema, root, now);
    expect(first.migration.latest).toBeNull();
    expect(first.migration.next).toBe("supabase/migrations/20261025200000_samesight.sql");
    expect([...first.files.keys()].sort()).toEqual([
      "powersync/service.yaml",
      "powersync/sync-config.yaml",
      "samesight/manifest.json",
      "samesight/schema.json",
      "src/samesight/app-schema.ts",
      "src/samesight/policy-types.ts",
    ]);

    mkdirSync(join(root, "supabase/migrations"), { recursive: true });
    writeFileSync(join(root, "supabase/migrations/20261025170000_schema.sql"), "");
    writeFileSync(join(root, "supabase/migrations/20261025200000_samesight.sql"), first.migration.content);
    writeFileSync(join(root, "supabase/migrations/20261026090000_later.sql"), "");
    const second = plan(fieldbookPolicy, fieldbookSchema, root, now);
    expect(second.migration.latest).toEqual({ path: "supabase/migrations/20261025200000_samesight.sql", content: first.migration.content });
    // A change would go after the newest migration of any kind.
    expect(second.migration.next).toBe("supabase/migrations/20261026090001_samesight.sql");
  });

  it("points the service config at the sync config", () => {
    const p = plan(fieldbookPolicy, fieldbookSchema, root, now);
    expect(p.files.get("powersync/service.yaml")).toContain("  path: sync-config.yaml\n");
  });
});

describe("outputPaths", () => {
  const withOutput = (output: Record<string, string | undefined>) => definePolicy({ ...fieldbookPolicy.spec, output });
  it("keeps outputs inside the project and distinct", () => {
    expect(outputPaths(withOutput({ syncConfig: undefined })).syncConfig).toBe("powersync/sync-config.yaml");
    expect(() => outputPaths(withOutput({ syncConfig: "../../elsewhere.yaml" }))).toThrow(/output.syncConfig must be a relative path/);
    expect(() => outputPaths(withOutput({ manifest: "/etc/x.json" }))).toThrow(/output.manifest/);
    expect(() => outputPaths(withOutput({ manifest: "C:\\x.json" }))).toThrow(/output.manifest/);
    expect(() => outputPaths(withOutput({ manifest: "powersync/./sync-config.yaml" }))).toThrow(/same path/);
  });
});

describe("isPolicy", () => {
  it("needs the policy's tables and membership, not only its kind", () => {
    expect(isPolicy(fieldbookPolicy)).toBe(true);
    expect(isPolicy({ kind: "samesight-policy" })).toBe(false);
    expect(isPolicy({ kind: "samesight-policy", spec: { tables: {} } })).toBe(false);
  });
});
