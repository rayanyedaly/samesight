import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { chooseAuth, serviceConfig } from "./config.ts";

const base = {
  dataSource: "postgresql://samesight_audit_a1:pw@supabase_db_todo:5432/postgres",
  storage: "postgresql://powersync_storage:pw2@samesight-audit-a1-storage:5432/powersync_storage",
  slotPrefix: "samesight_audit_a1_",
  syncConfig: "config:\n  edition: 3\nstreams:\n  s:\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id()\n",
};

describe("serviceConfig", () => {
  it("is the generated config with the run's connections, slot prefix and sync config inlined", () => {
    const text = serviceConfig({ ...base, auth: { jwksUri: "http://supabase_kong_todo:8000/auth/v1/.well-known/jwks.json" } });
    expect(text).not.toMatch(/!env/);
    expect(parse(text)).toEqual({
      telemetry: { disable_telemetry_sharing: true },
      replication: { connections: [{ type: "postgresql", uri: base.dataSource, sslmode: "disable", slot_name_prefix: "samesight_audit_a1_" }] },
      storage: { type: "postgresql", uri: base.storage, sslmode: "disable" },
      port: 8080,
      sync_config: { content: base.syncConfig },
      client_auth: { supabase: true, jwks_uri: "http://supabase_kong_todo:8000/auth/v1/.well-known/jwks.json", audience: ["authenticated"] },
    });
  });

  it("checks tokens with the shared secret when there is no signing key", () => {
    const text = serviceConfig({ ...base, auth: { jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long" } });
    expect(text).toMatch(/# Verify Supabase Auth tokens with the local project's shared HS256 secret\./);
    expect(text).not.toMatch(/JWKS/);
    const config = parse(text);
    expect(config.client_auth).toEqual({ supabase: true, supabase_jwt_secret: "super-secret-jwt-token-with-at-least-32-characters-long", audience: ["authenticated"] });
  });
});

describe("chooseAuth", () => {
  it("uses the JWKS through the gateway when Auth publishes a key, else the secret", () => {
    expect(chooseAuth({ keys: [{ kty: "EC" }] }, "supabase_kong_todo", "secret")).toEqual({ jwksUri: "http://supabase_kong_todo:8000/auth/v1/.well-known/jwks.json" });
    expect(chooseAuth({ keys: [] }, "k", "secret")).toEqual({ jwtSecret: "secret" });
    expect(chooseAuth(null, "k", "secret")).toEqual({ jwtSecret: "secret" });
  });

  it("says to make a signing key when there is neither", () => {
    expect(() => chooseAuth({ keys: [] }, "k", undefined)).toThrow(/run `supabase gen signing-key`/);
  });
});
