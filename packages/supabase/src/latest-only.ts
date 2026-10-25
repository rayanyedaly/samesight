/** A row of an append-only table where corrections supersede earlier rows. */
export interface SupersedingRow {
  id: string;
  supersedesId?: string | null;
  /** Server-assigned order; null while the row has not synced yet. */
  seq?: number | null;
}

// A row the server has not applied yet will get the highest seq when it is, so it
// ranks after every synced row.
const rank = (row: SupersedingRow | undefined) => (row?.seq == null ? Number.POSITIVE_INFINITY : row.seq);

// A row naming itself supersedes nothing. A schema check should prevent it; treating it
// as a link would hide that row for good.
const parentOf = (row: SupersedingRow) => (row.supersedesId && row.supersedesId !== row.id ? row.supersedesId : null);

/**
 * Reduce an append-only table's rows to the current ones: drop any row that a later row
 * supersedes, and resolve forks by the server sequence.
 *
 * A fork is two rows that supersede the same parent (two offline devices each amend the
 * same row). The child the server applied last (highest `seq`) wins, so client clock
 * skew cannot invert a chain. Fork resolution is transitive: a row survives only if it
 * is not superseded and no row on its chain lost a fork, so a further correction on a
 * losing branch does not resurface as a second current row. Ties keep the first row
 * seen.
 */
export function latestOnly<T extends SupersedingRow>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const superseded = new Set(rows.map(parentOf).filter((p): p is string => p !== null));

  const winnerChildByParent = new Map<string, string>();
  for (const r of rows) {
    const parent = parentOf(r);
    if (!parent) continue;
    const current = winnerChildByParent.get(parent);
    if (current === undefined || rank(r) > rank(byId.get(current))) winnerChildByParent.set(parent, r.id);
  }

  const lostFork = (r: T) => {
    const parent = parentOf(r);
    return parent !== null && winnerChildByParent.get(parent) !== r.id;
  };

  const onLosingBranch = (row: T): boolean => {
    const seen = new Set<string>();
    let current: T | undefined = row;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (lostFork(current)) return true;
      const parent = parentOf(current);
      current = parent ? byId.get(parent) : undefined;
    }
    return false;
  };

  return rows.filter((r) => !superseded.has(r.id) && !onLosingBranch(r));
}

/** The rows `row` corrects, newest first, as far back as they are present. */
export function earlierVersions<T extends SupersedingRow>(rows: T[], row: T): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const earlier: T[] = [];
  const seen = new Set([row.id]);
  let parent = parentOf(row);
  let previous = parent ? byId.get(parent) : undefined;
  while (previous && !seen.has(previous.id)) {
    seen.add(previous.id);
    earlier.push(previous);
    parent = parentOf(previous);
    previous = parent ? byId.get(parent) : undefined;
  }
  return earlier;
}
