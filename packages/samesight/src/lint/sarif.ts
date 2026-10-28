/**
 * `samesight lint --format sarif`: one SARIF 2.1.0 log, for code scanning (GitHub shows its
 * results on the pull request lines they point to). Findings --allow accepted are results
 * with an external suppression; files that could not be read are tool notifications.
 */

import { createHash } from "node:crypto";
import { type LintFinding, type LintLevel, type LintRun, repoPath, sortFindings } from "./finding.ts";
import { RULE_INFO } from "./rule-info.ts";

export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const REPO = "https://github.com/rayanyedaly/samesight";

type SarifLevel = "error" | "warning" | "note";
const LEVEL: Record<LintLevel, SarifLevel> = { error: "error", warning: "warning", info: "note" };

interface Location {
  physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number; startColumn?: number } };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level: SarifLevel;
  message: { text: string };
  locations: Location[];
  partialFingerprints: Record<string, string>;
  suppressions?: { kind: "external"; justification: string }[];
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: {
          id: string;
          name: string;
          shortDescription: { text: string };
          fullDescription: { text: string };
          helpUri: string;
          defaultConfiguration: { level: SarifLevel };
        }[];
      };
    };
    invocations: { executionSuccessful: boolean; toolExecutionNotifications?: { level: "error"; message: { text: string }; locations: Location[] }[] }[];
    columnKind: "utf16CodeUnits";
    results: SarifResult[];
  }[];
}

/** A file as a URI reference: forward slashes, no leading ./, each segment percent-encoded. */
const uri = (file: string) => repoPath(file).split("/").map(encodeURIComponent).join("/");

/** Every finding has a location, since GitHub drops results without one; a region only with a line. */
function location(file: string, line?: number, column?: number): Location {
  const region = line ? { region: { startLine: line, ...(column ? { startColumn: column } : {}) } } : {};
  return { physicalLocation: { artifactLocation: { uri: uri(file) }, ...region } };
}

/**
 * Stable across runs, machines and line moves: the rule, the file, the subjects and the
 * message with any `file:line` it names (rls-open names the policy's) reduced to the file.
 */
export function fingerprint(f: LintFinding): string {
  const message = f.message.replace(/\\/g, "/").replace(/:\d+\b/g, "");
  return createHash("sha256")
    .update(JSON.stringify([f.rule, repoPath(f.file), f.subjects ?? [], message]))
    .digest("hex");
}

/** The SARIF log for one lint run; `version` is samesight's. */
export function formatSarif(run: LintRun, version: string): SarifLog {
  const ids = Object.keys(RULE_INFO);
  const result = (f: LintFinding, allowed: boolean): SarifResult => {
    const index = ids.indexOf(f.rule);
    return {
      ruleId: f.rule,
      ...(index === -1 ? {} : { ruleIndex: index }),
      level: LEVEL[f.level],
      message: { text: f.message },
      locations: [location(f.file, f.line, f.column)],
      partialFingerprints: { "samesight/v1": fingerprint(f) },
      ...(allowed ? { suppressions: [{ kind: "external" as const, justification: "allowed with --allow" }] } : {}),
    };
  };
  const notifications = run.unreadable.map((u) => ({
    level: "error" as const,
    message: { text: `${u.file} cannot be read as a sync config: ${u.error}` },
    locations: [location(u.file)],
  }));
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "samesight",
            version,
            informationUri: REPO,
            rules: Object.entries(RULE_INFO).map(([id, info]) => ({
              id,
              name: id,
              shortDescription: { text: info.summary },
              fullDescription: { text: info.description },
              helpUri: info.help,
              defaultConfiguration: { level: LEVEL[info.level] },
            })),
          },
        },
        invocations: [{ executionSuccessful: notifications.length === 0, ...(notifications.length ? { toolExecutionNotifications: notifications } : {}) }],
        columnKind: "utf16CodeUnits",
        results: [...sortFindings(run.kept).map((f) => result(f, false)), ...sortFindings(run.allowed).map((f) => result(f, true))],
      },
    ],
  };
}
