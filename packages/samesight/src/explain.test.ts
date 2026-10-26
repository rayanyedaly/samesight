import { describe, expect, it } from "vitest";
import { explainPolicy } from "./explain.ts";
import { fieldbookPolicy, fieldbookSchema } from "./fixtures/fieldbook.ts";
import { buildIR } from "./ir.ts";

describe("explainPolicy", () => {
  const ir = buildIR(fieldbookPolicy, fieldbookSchema);

  it("draws the who-does-what matrix", () => {
    const text = explainPolicy(ir);
    expect(text).toContain(
      [
        "            ADMIN      INSPECTOR  VIEWER",
        "Tenant      R---       R---       R---",
        "Membership  R---       r---       r---",
        "Site        RIUD       R---       R---",
        "Inspection  RIUD       r-u-       r---",
        "Finding     r---       ri--       r---",
        "Photo       r---       ri--       r---",
      ].join("\n"),
    );
  });

  it("says each rule in words, with write columns and hidden columns", () => {
    const text = explainPolicy(ir, "Inspection");
    expect(text).not.toContain("\nSite (");
    expect(text).toContain("    INSPECTOR: rows where assigneeId = the signed-in user\n");
    expect(text).toContain("    VIEWER: rows where status is one of PUBLISHED, ARCHIVED\n");
    expect(text).toContain(
      "    INSPECTOR: rows where assigneeId = the signed-in user and status is one of DRAFT, IN_PROGRESS (before and after the change)\n",
    );
    expect(text).toContain(
      "  every insert and update must have: assigneeId is null or assigneeId is the userId of a Membership row the user can read where role = INSPECTOR\n",
    );
    expect(text).toContain("  clients set on insert only: siteId\n");
    expect(text).toContain("  the server sets: createdAt, tenantId (from the token), updatedAt (now(), on every update)\n");
    expect(text).toContain("  never synced to VIEWER: internalNotes");
  });

  it("describes append-only tables and via rules", () => {
    const text = explainPolicy(ir, "Finding");
    expect(text).toContain("    ADMIN, INSPECTOR, VIEWER: rows where the Inspection row that inspectionId points to is readable by the user\n");
    expect(text).toContain("    INSPECTOR: new rows where the Inspection row that inspectionId points to is readable by the user\n");
    expect(text).toContain("  append-only: rows are never updated or deleted; a correction is a new row whose supersedesId names the row it replaces");
    expect(text).toContain("createdBy (the signed-in user)");
  });

  it("refuses a table the policy does not cover", () => {
    expect(() => explainPolicy(ir, "Nope")).toThrow(/no table "Nope" in the policy/);
  });
});
