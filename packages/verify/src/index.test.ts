import { describe, expect, it } from "vitest";
import { ir, syncConfig } from "./fixtures/fieldbook.ts";
import { checkStreams, failed, formatFindings, parseStreams } from "./index.ts";

describe("@samesight/verify", () => {
  it("exports the offline checks", () => {
    const findings = checkStreams(ir, parseStreams(syncConfig));
    expect(failed(findings)).toBe(false);
    expect(formatFindings(findings)).toMatch(/^ok {2}/);
  });
});
