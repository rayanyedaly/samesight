import { describe, expect, it } from "vitest";
import { packageName } from "./index";

describe("samesight", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("samesight");
  });
});
