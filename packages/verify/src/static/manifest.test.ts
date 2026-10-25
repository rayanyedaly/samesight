import { describe, expect, it } from "vitest";
import { latestMigration, read } from "../fixtures/fieldbook.ts";
import { checkManifest, type Manifest } from "./manifest.ts";

const manifest = JSON.parse(read("samesight/manifest.json")) as Manifest;
const files = (overrides: Record<string, string | null> = {}) => (path: string) =>
  path in overrides ? (overrides[path] ?? null) : path === "migration" ? latestMigration() : read(path);

describe("checkManifest", () => {
  it("passes Fieldbook's generated files", () => {
    expect(checkManifest(manifest, files())).toEqual([{ status: "ok", check: "manifest", detail: "all 5 generated files match the manifest" }]);
  });

  it("fails a hand-edited or missing file", () => {
    const edited = files({ "powersync/sync-config.yaml": `${read("powersync/sync-config.yaml")}# edited\n`, migration: null });
    expect(checkManifest(manifest, edited).map((f) => `${f.status}: ${f.detail}`)).toEqual([
      "fail: powersync/sync-config.yaml differs from what the policy generated; run samesight generate",
      "fail: the latest generated migration is missing",
    ]);
  });

  it("refuses a manifest another tool wrote", () => {
    expect(checkManifest({ ...manifest, generator: "other" }, files())[0]?.status).toBe("fail");
  });
});
