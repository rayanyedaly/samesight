import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkAuthConfig, HOOK_URI, readSupabaseConfig } from "./supabase-config.ts";

/** A directory for one test, removed when it ends. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-config-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(toml: string): string {
  const dir = tempDir();
  mkdirSync(join(dir, "supabase"));
  writeFileSync(join(dir, "supabase", "config.toml"), toml);
  return dir;
}

describe("checkAuthConfig", () => {
  it("passes a project with the hook on and a signing key", () => {
    const config = readSupabaseConfig(
      project(`[auth]\nenabled = true\nsigning_keys_path = "./signing_keys.json"\n\n[auth.hook.custom_access_token]\nenabled = true # on\nuri = "${HOOK_URI}"\n`),
    );
    expect(checkAuthConfig(config)).toEqual([{ status: "ok", check: "auth config", detail: "the access token hook is on and calls samesight.custom_access_token_hook" }]);
  });

  it("fails a hook left commented out, as supabase init writes it, and warns without a signing key", () => {
    const findings = checkAuthConfig(readSupabaseConfig(project(`[auth]\nenabled = true\n# [auth.hook.custom_access_token]\n# enabled = true\n`)));
    expect(findings.map((f) => f.status)).toEqual(["fail", "warn"]);
    expect(findings[0]?.detail).toMatch(/hook is off/);
  });

  it("fails a hook that calls another function", () => {
    const findings = checkAuthConfig(readSupabaseConfig(project(`[auth.hook.custom_access_token]\nenabled = true\nuri = "pg-functions://postgres/public/my_hook"\n`)));
    expect(findings[0]).toMatchObject({ status: "fail", detail: expect.stringMatching(/calls pg-functions:\/\/postgres\/public\/my_hook/) });
  });

  it("reads single-quoted values", () => {
    const config = readSupabaseConfig(project(`[auth]\nsigning_keys_path = './keys.json'\n[auth.hook.custom_access_token]\nenabled = true\nuri = '${HOOK_URI}'\n`));
    expect(checkAuthConfig(config).map((f) => f.status)).toEqual(["ok"]);
  });

  it("warns when there is no config.toml", () => {
    expect(checkAuthConfig(readSupabaseConfig(tempDir()))[0]?.status).toBe("warn");
  });
});
