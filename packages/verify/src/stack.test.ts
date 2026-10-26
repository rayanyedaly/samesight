import { describe, expect, it } from "vitest";
import { parseEnv, stackFromStatus } from "./stack.ts";

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

  it("falls back to the legacy key names", () => {
    const legacy = { ...status, PUBLISHABLE_KEY: "", SECRET_KEY: "", ANON_KEY: "anon", SERVICE_ROLE_KEY: "service" };
    expect(stackFromStatus(legacy, "http://localhost:8080", { NODE_ENV: "test" })).toMatchObject({ publishableKey: "anon", secretKey: "service" });
  });

  it("refuses a stack that is not this machine, or a missing value", () => {
    expect(() => stackFromStatus(status, "https://powersync.example.com", { NODE_ENV: "test" })).toThrow(/PowerSync: powersync.example.com is not this machine/);
    expect(() => stackFromStatus({ ...status, API_URL: "https://abc.supabase.co" }, "http://127.0.0.1:8080", { NODE_ENV: "test" })).toThrow(/Supabase API/);
    expect(() => stackFromStatus({ ...status, DB_URL: "" }, "http://127.0.0.1:8080", { NODE_ENV: "test" })).toThrow(/none of DB_URL/);
  });
});
