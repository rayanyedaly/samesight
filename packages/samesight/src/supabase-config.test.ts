import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAuthConfig, HOOK_URI, readSupabaseConfig } from "./supabase-config.ts";

function project(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "samesight-config-"));
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

  it("warns when there is no config.toml", () => {
    expect(checkAuthConfig(readSupabaseConfig(mkdtempSync(join(tmpdir(), "samesight-config-"))))[0]?.status).toBe("warn");
  });
});
