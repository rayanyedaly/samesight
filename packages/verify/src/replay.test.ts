import { describe, expect, it } from "vitest";
import { MAX_SEED, readSeed, replayCommand, shellQuote } from "./replay.ts";

describe("replayCommand", () => {
  it("keeps the run's own flags in audit mode, and puts the failing seed last", () => {
    expect(replayCommand("audit", ["--project", "upstream", "--sync-config", "upstream/sync-config.planted.yaml", "--runs", "3", "--time-limit", "60"], 1842)).toBe(
      "samesight-verify audit --project upstream --sync-config upstream/sync-config.planted.yaml --runs 3 --time-limit 60 --seed 1842",
    );
  });

  it("drops --seed, --json and --report in either spelling, with their values", () => {
    expect(replayCommand("policy", ["--seed", "7", "--runs", "4", "--json", "--report", "out.md"], 9)).toBe("samesight-verify --runs 4 --seed 9");
    expect(replayCommand("audit", ["--seed=7", "--report=out.md", "--time-limit=60", "--powersync", "http://127.0.0.1:8080"], 9)).toBe(
      "samesight-verify audit --time-limit=60 --powersync http://127.0.0.1:8080 --seed 9",
    );
    // A value that only looks like a dropped flag stays.
    expect(replayCommand("policy", ["--restart=--seed 3"], 0)).toBe("samesight-verify '--restart=--seed 3' --seed 0");
  });

  it("names no audit in policy mode", () => {
    expect(replayCommand("policy", [], 5)).toBe("samesight-verify --seed 5");
    expect(replayCommand("policy", ["--mutate", "--restart", "docker compose restart powersync"], 5)).toBe(
      "samesight-verify --mutate --restart 'docker compose restart powersync' --seed 5",
    );
  });

  it("quotes what a shell would split or expand", () => {
    expect(replayCommand("audit", ["--sync-config", "my sync/config.yaml", "--project", "$HOME/it's"], 1)).toBe(
      `samesight-verify audit --sync-config 'my sync/config.yaml' --project '$HOME/it'\\''s' --seed 1`,
    );
  });
});

describe("shellQuote", () => {
  it("leaves plain words as they are and quotes the rest", () => {
    expect(shellQuote("a-Z_0.9/x:y=z@%+,")).toBe("a-Z_0.9/x:y=z@%+,");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("*.yaml")).toBe("'*.yaml'");
    expect(shellQuote("a;b")).toBe("'a;b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("readSeed", () => {
  it("takes a whole number from 0 to MAX_SEED, as Number reads it, and nothing else", () => {
    expect(["0", "42", "1e3", "0x10", " 7 ", String(MAX_SEED)].map(readSeed)).toEqual([0, 42, 1000, 16, 7, MAX_SEED]);
    expect(["", " ", "-1", "1.5", "x", String(MAX_SEED + 1), "1e300"].map(readSeed)).toEqual(Array(7).fill(undefined));
  });
});
