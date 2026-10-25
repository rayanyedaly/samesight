import { earlierVersions, latestOnly } from "@samesight/supabase";
import type { FindingRecord } from "./powersync/schema";

export type Finding = FindingRecord & { id: string };
export type FindingChain = { latest: Finding; earlier: Finding[] };

// Findings are append-only: an amendment is a new row whose supersedesId points at the
// row it replaces. Show the current row of each chain, with its history newest first.
// When two devices amend the same row offline, the amendment the server applied last
// (highest seq) is current; the other branch stays stored but is not shown.
export function findingChains(findings: Finding[]): FindingChain[] {
  return latestOnly(findings).map((latest) => ({ latest, earlier: earlierVersions(findings, latest) }));
}
