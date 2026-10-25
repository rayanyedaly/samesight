import { describe, expect, it } from "vitest";
import { isPermanent } from "./upload-errors";

describe("isPermanent", () => {
  it("drops rejections that cannot succeed on retry", () => {
    for (const status of [400, 403, 404, 409]) expect(isPermanent(status)).toBe(true);
  });

  it("retries network failures, expired tokens, rate limits and server errors", () => {
    for (const status of [0, 401, 408, 429, 500, 502, 503]) expect(isPermanent(status)).toBe(false);
  });
});
