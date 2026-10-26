import { describe, expect, it } from "vitest";
import { checkUserEditableClaims } from "./catalog.ts";

describe("checkUserEditableClaims", () => {
  it("fails a policy or stream that reads user_metadata, which users set on themselves", () => {
    expect(
      checkUserEditableClaims([
        { where: 'policy "admins" on lists', sql: "((auth.jwt() -> 'user_metadata') ->> 'role') = 'admin'" },
        { where: "s.query", sql: "SELECT * FROM lists WHERE owner_id = auth.user_id()" },
      ]),
    ).toEqual([
      {
        status: "fail",
        check: "user metadata",
        detail: 'policy "admins" on lists reads user_metadata, which every user can set on themselves; decide access from app_metadata or a table instead',
      },
    ]);
    expect(checkUserEditableClaims([{ where: "s.query", sql: "SELECT 1" }])[0]?.status).toBe("ok");
  });
});
