import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "./load.ts";

describe("loadPolicy", () => {
  const dir = mkdtempSync(join(tmpdir(), "samesight-load-"));

  it("refuses a missing file", async () => {
    await expect(loadPolicy(join(dir, "missing.ts"))).rejects.toThrow(/No policy file at/);
  });

  it("refuses a default export that definePolicy did not build", async () => {
    const path = join(dir, "plain.mjs");
    writeFileSync(path, "export default { spec: { tables: {}, membership: {} } };\n");
    await expect(loadPolicy(path)).rejects.toThrow(/must `export default definePolicy\(\.\.\.\)`/);
  });
});
