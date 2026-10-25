import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("@samesight/supabase", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@samesight/supabase");
  });
});
