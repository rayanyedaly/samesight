import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditScope } from "./scope.ts";
import { parseSyncConfig } from "samesight/compiler";

// Real sync configs from PowerSync's demos, and copies with a planted leak: see corpus/SOURCES.md.
const corpus = fileURLToPath(new URL("../../../../corpus/", import.meta.url));
const files = (dir: string) => readdirSync(join(corpus, dir)).filter((f) => f.endsWith(".yaml")).sort();
const read = (dir: string, f: string) => readFileSync(join(corpus, dir, f), "utf8");

/** What audit makes of a config: its format, the tables it sends, and each warning or failure by its opening clause. */
function summary(text: string) {
  const config = parseSyncConfig(text);
  const scope = auditScope(config.streams, config.kind);
  return {
    format: config.kind,
    streams: config.streams.map((s) => s.name),
    synced: scope.synced,
    findings: [...config.findings, ...scope.findings].filter((f) => f.status !== "ok").map((f) => `${f.status}: ${f.detail.split(/[(;,]/)[0]?.trim()}`),
  };
}

describe("corpus", () => {
  it("holds at least 8 real configs and 4 planted leaks", () => {
    expect(files("real").length).toBeGreaterThanOrEqual(8);
    expect(files("planted").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps each real config byte for byte as SOURCES.md records it", () => {
    const sources = readFileSync(join(corpus, "SOURCES.md"), "utf8");
    const recorded = new Map([...sources.matchAll(/^([0-9a-f]{64}) {2}(\S+\.yaml)$/gm)].map((m) => [m[2], m[1]]));
    expect([...recorded.keys()].sort()).toEqual(files("real"));
    for (const f of files("real")) {
      expect(createHash("sha256").update(readFileSync(join(corpus, "real", f))).digest("hex"), f).toBe(recorded.get(f));
    }
  });

  it.each(files("real"))("parses real/%s", (f) => {
    expect(summary(read("real", f))).toMatchSnapshot();
  });

  it.each(files("planted"))("parses planted/%s", (f) => {
    expect(summary(read("planted", f))).toMatchSnapshot();
  });
});
