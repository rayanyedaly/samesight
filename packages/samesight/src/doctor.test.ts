import { describe, expect, it } from "vitest";
import { replicationRole } from "./doctor.ts";

describe("doctor's replication role check", () => {
  it("says how to make the role, or give it what it lacks", () => {
    expect(replicationRole(undefined)).toEqual({
      status: "fail",
      check: "replication role",
      detail: "powersync_role does not exist; run samesight generate, then apply the migration (supabase migration up)",
    });
    // Applying the migration again would not change a role that exists.
    expect(replicationRole({ replication: true, bypassrls: false, login: true }).detail).toBe(
      "powersync_role needs REPLICATION and BYPASSRLS; the migration leaves a role that exists as it is, so run alter role powersync_role with replication bypassrls (as supabase_admin)",
    );
    expect(replicationRole({ replication: false, bypassrls: true, login: true }).status).toBe("fail");
    expect(replicationRole({ replication: true, bypassrls: true, login: false })).toMatchObject({ status: "warn", detail: "powersync_role cannot log in yet; set its password" });
    expect(replicationRole({ replication: true, bypassrls: true, login: true })).toMatchObject({ status: "ok", detail: "powersync_role is ready" });
  });
});
