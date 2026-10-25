import type { FindingRecord } from "./powersync/schema";

export type Finding = FindingRecord & { id: string };
export type FindingChain = { latest: Finding; earlier: Finding[] };

// Findings are append-only: an amendment is a new row whose supersedesId points at
// the row it replaces. Show the newest row of each chain, with its history.
//
// Two amendments of the same row (two devices offline) give two chains that share
// their history; both are shown.
export function latestOnly(findings: Finding[]): FindingChain[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  // A row naming itself supersedes nothing. The schema rejects it; this keeps such a
  // row visible rather than hiding it for good.
  const superseded = new Set(findings.filter((f) => f.supersedesId && f.supersedesId !== f.id).map((f) => f.supersedesId));
  return findings
    .filter((f) => !superseded.has(f.id))
    .map((latest) => {
      const earlier: Finding[] = [];
      const seen = new Set([latest.id]);
      let prev = latest.supersedesId ? byId.get(latest.supersedesId) : undefined;
      while (prev && !seen.has(prev.id)) {
        seen.add(prev.id);
        earlier.push(prev);
        prev = prev.supersedesId ? byId.get(prev.supersedesId) : undefined;
      }
      return { latest, earlier };
    });
}
