import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy, resolvePolicyPath, tsIsModule } from "./load.ts";

describe("loadPolicy", () => {
  const dir = mkdtempSync(join(tmpdir(), "samesight-load-"));

  it("refuses a missing file", async () => {
    await expect(loadPolicy(join(dir, "missing.ts"))).rejects.toThrow(/^no policy file at .*missing\.ts; run samesight init, or pass --policy$/);
  });

  it("refuses a default export that definePolicy did not build", async () => {
    const path = join(dir, "plain.mjs");
    writeFileSync(path, "export default { spec: { tables: {}, membership: {} } };\n");
    await expect(loadPolicy(path)).rejects.toThrow(/must `export default definePolicy\(\.\.\.\)`/);
  });
});

describe("resolvePolicyPath", () => {
  it("takes the given path, else samesight.policy.ts, else samesight.policy.mts", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-find-"));
    expect(resolvePolicyPath("policies/a.ts", dir)).toBe(join(dir, "policies/a.ts"));
    expect(resolvePolicyPath(undefined, dir)).toBe(join(dir, "samesight.policy.ts"));
    writeFileSync(join(dir, "samesight.policy.mts"), "");
    expect(resolvePolicyPath(undefined, dir)).toBe(join(dir, "samesight.policy.mts"));
    writeFileSync(join(dir, "samesight.policy.ts"), "");
    expect(resolvePolicyPath(undefined, dir)).toBe(join(dir, "samesight.policy.ts"));
  });
});

describe("tsIsModule", () => {
  it("reads the nearest package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "samesight-type-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    expect(tsIsModule(join(dir, "app"))).toBe(true);
    writeFileSync(join(dir, "app", "package.json"), JSON.stringify({ name: "app" }));
    expect(tsIsModule(join(dir, "app"))).toBe(false);
  });
});
