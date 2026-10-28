import { describe, expect, it } from "vitest";
import type { LintFinding } from "./finding.ts";
import { RULE_NAMES } from "./lint.ts";
import { fingerprint, formatSarif } from "./sarif.ts";

const hash = expect.stringMatching(/^[0-9a-f]{64}$/);
const at = (uri: string, region?: object) => [{ physicalLocation: { artifactLocation: { uri }, ...(region ? { region } : {}) } }];

const error: LintFinding = { rule: "unscoped-query", level: "error", file: "./powersync/sync-config.yaml", line: 6, column: 12, message: "stream all sends every row", subjects: ["all", "customers"] };
const warning: LintFinding = { rule: "rls-off", level: "warning", file: "powersync\\sync-config.yaml", line: 9, column: 7, message: "todos is synced without RLS", subjects: ["todos"] };
const info: LintFinding = { rule: "not-auto-subscribed", level: "info", file: "sync config.yaml", line: 3, message: "stream s is not auto_subscribe", subjects: ["s"] };
const wholeFile: LintFinding = { rule: "unreadable-query", level: "warning", file: "/abs/sync-rules.yaml", message: "bucket b cannot be checked", subjects: ["b"] };
const allowed: LintFinding = { rule: "unscoped-query", level: "warning", file: "sync-config.yaml", line: 4, column: 12, message: "stream pub sends public rows", subjects: ["pub", "posts"] };

describe("formatSarif", () => {
  it("gives every finding a result at its file and, when known, its line and column", () => {
    const log = formatSarif({ kept: [wholeFile, info, warning, error], allowed: [allowed], unreadable: [{ file: "./bad.yaml", error: "the sync config has no streams: section" }] }, "1.2.3");
    expect(log).toEqual({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "samesight", version: "1.2.3", informationUri: "https://github.com/rayanyedaly/samesight", rules: expect.any(Array) } },
          invocations: [
            {
              executionSuccessful: false,
              toolExecutionNotifications: [{ level: "error", message: { text: "./bad.yaml cannot be read as a sync config: the sync config has no streams: section" }, locations: at("bad.yaml") }],
            },
          ],
          columnKind: "utf16CodeUnits",
          results: [
            {
              ruleId: "unscoped-query",
              ruleIndex: 0,
              level: "error",
              message: { text: "stream all sends every row" },
              locations: at("powersync/sync-config.yaml", { startLine: 6, startColumn: 12 }),
              partialFingerprints: { "samesight/v1": hash },
            },
            { ruleId: "unreadable-query", ruleIndex: 3, level: "warning", message: { text: "bucket b cannot be checked" }, locations: at("/abs/sync-rules.yaml"), partialFingerprints: { "samesight/v1": hash } },
            { ruleId: "rls-off", ruleIndex: 5, level: "warning", message: { text: "todos is synced without RLS" }, locations: at("powersync/sync-config.yaml", { startLine: 9, startColumn: 7 }), partialFingerprints: { "samesight/v1": hash } },
            { ruleId: "not-auto-subscribed", ruleIndex: 4, level: "note", message: { text: "stream s is not auto_subscribe" }, locations: at("sync%20config.yaml", { startLine: 3 }), partialFingerprints: { "samesight/v1": hash } },
            {
              ruleId: "unscoped-query",
              ruleIndex: 0,
              level: "warning",
              message: { text: "stream pub sends public rows" },
              locations: at("sync-config.yaml", { startLine: 4, startColumn: 12 }),
              partialFingerprints: { "samesight/v1": hash },
              suppressions: [{ kind: "external", justification: "allowed with --allow" }],
            },
          ],
        },
      ],
    });
  });

  it("describes every rule, with its level as SARIF names it and its docs", () => {
    const rules = formatSarif({ kept: [], allowed: [], unreadable: [] }, "0.1.0").runs[0]?.tool.driver.rules ?? [];
    expect(rules.map((r) => r.id)).toEqual(RULE_NAMES);
    expect(rules[4]).toEqual({
      id: "not-auto-subscribed",
      name: "not-auto-subscribed",
      shortDescription: { text: "A stream devices get only when the app subscribes, which audit does not test." },
      fullDescription: { text: expect.stringMatching(/^A stream that is not auto_subscribe /) },
      helpUri: "https://github.com/rayanyedaly/samesight/blob/main/docs/cli.md#not-auto-subscribed",
      defaultConfiguration: { level: "note" },
    });
  });

  it("succeeds with no notifications when every file was read", () => {
    expect(formatSarif({ kept: [], allowed: [], unreadable: [] }, "0.1.0").runs[0]?.invocations).toEqual([{ executionSuccessful: true }]);
  });

  it("fingerprints a finding by rule, file, subjects and message, not by its line", () => {
    expect(fingerprint(error)).toBe(fingerprint({ ...error, file: "powersync/sync-config.yaml", line: 40, column: 1 }));
    expect(fingerprint(error)).not.toBe(fingerprint({ ...error, subjects: ["all", "orders"] }));
    expect(fingerprint(error)).not.toBe(fingerprint({ ...error, rule: "client-scoped" }));
    expect(fingerprint(error)).not.toBe(fingerprint({ ...error, message: "other" }));
  });
});
