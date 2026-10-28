import { describe, expect, it } from "vitest";
import { assertLocalTargets, DEPLOYED } from "./guard.ts";

const local = {
  db: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  http: { supabase: "http://127.0.0.1:54321", powersync: "http://localhost:8080" },
};

describe("assertLocalTargets", () => {
  it("accepts the Supabase CLI stack and a local PowerSync", () => {
    expect(() => assertLocalTargets(local, {})).not.toThrow();
    expect(() => assertLocalTargets(local, { NODE_ENV: "test", CI: "true" })).not.toThrow();
  });

  it("refuses a hosted database, including one hidden in the query", () => {
    expect(() => assertLocalTargets({ ...local, db: "postgresql://u:p@db.abc.supabase.co:5432/postgres" }, {})).toThrow(/database: .*only connects/);
    expect(() => assertLocalTargets({ ...local, db: "postgresql://u:p@127.0.0.1/db?host=db.abc.supabase.co" }, {})).toThrow(/cannot set host/);
  });

  it("refuses remote or malformed HTTP services", () => {
    expect(() => assertLocalTargets({ ...local, http: { supabase: "https://abc.supabase.co" } }, {})).toThrow(/supabase: abc.supabase.co is not this machine/);
    expect(() => assertLocalTargets({ ...local, http: { powersync: "https://x.powersync.journeyapps.com" } }, {})).toThrow(/powersync:/);
    expect(() => assertLocalTargets({ ...local, http: { powersync: "127.0.0.1:8080" } }, {})).toThrow(/powersync: /);
    expect(() => assertLocalTargets({ ...local, http: { powersync: "http://127.0.0.1.evil.example" } }, {})).toThrow(/not this machine/);
    expect(() => assertLocalTargets({ ...local, http: { powersync: "http://127.0.0.1@evil.example" } }, {})).toThrow(/evil.example is not this machine/);
    expect(() => assertLocalTargets({ ...local, http: { powersync: "file:///etc/passwd" } }, {})).toThrow("is not an http(s) URL");
    expect(() => assertLocalTargets({ ...local, http: { powersync: "http://[::1]:8080" } }, {})).not.toThrow();
  });

  it("refuses a production NODE_ENV or a hosting platform, and lists every problem", () => {
    expect(() => assertLocalTargets(local, { NODE_ENV: "production" })).toThrow(
      /^refuses to run:\n {2}- NODE_ENV is "production"; the verifier runs only in development or test: unset NODE_ENV, or set it to development or test\n/,
    );
    for (const name of DEPLOYED) {
      expect(() => assertLocalTargets(local, { [name]: "1" }), name).toThrow(`${name} is set, so this looks like a deployment; run it on a developer machine or in CI`);
    }
    const all = () => assertLocalTargets({ db: "postgresql://u:p@remote/db", http: { supabase: "https://remote" } }, { FLY_APP_NAME: "x" });
    expect(all).toThrow(/database:[\s\S]*supabase:[\s\S]*FLY_APP_NAME/);
  });
});
