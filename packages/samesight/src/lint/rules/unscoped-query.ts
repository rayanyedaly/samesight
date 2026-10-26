/**
 * unscoped-query: rows every user receives, because nothing ties them to who is asking.
 *
 * - A stream query that reads no token value (auth.user_id(), auth.parameter()), directly
 *   or through a CTE it reads with IN.
 * - A sync rules data query that reads no bucket parameter: every user the bucket reaches
 *   gets every row (a bucket with no parameter query reaches everyone).
 * - A sync rules parameter query that reads no token value: it hands its buckets to every
 *   user.
 *
 * With no WHERE at all it is an error. Filtered only by fixed values (status = 'public'),
 * it is a warning: often public data by design. Queries filtered by what the client sends
 * are client-scoped's to report, not this rule's.
 */

import type { LintFinding } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";
import { hasWhere, inNames, readsBucket, readsClient, readsToken, tableOf, tokens } from "../sql.ts";

const RULE = "unscoped-query";

export const unscopedQuery: LintRule = defineRule(RULE, ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const add = (sql: string, filtered: boolean, subjects: string[], message: string) =>
    out.push({ rule: RULE, level: filtered ? "warning" : "error", file, line: lineOf(sql), message, subjects });

  for (const s of config.streams) {
    if (config.kind === "streams") {
      const ctes = new Map([...s.ctes].map(([name, sql]) => [name.toLowerCase(), tokens(sql)]));
      for (const q of s.queries) {
        const t = tokens(q.sql);
        if (!t) continue;
        const read = inNames(t).filter((n) => ctes.has(n)).map((n) => ctes.get(n));
        if (read.some((c) => c === null)) continue;
        if ([t, ...read].some((x) => x && (readsToken(x) || readsClient(x)))) continue;
        const table = tableOf(q.sql);
        add(
          q.sql,
          hasWhere(t),
          [s.name, table],
          hasWhere(t)
            ? `stream ${s.name}, ${q.label} sends every user the same ${table} rows, filtered only by fixed values; fine if they are public by design`
            : `stream ${s.name}, ${q.label} sends every ${table} row to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim`,
        );
      }
      continue;
    }

    // Sync rules: the parameter queries decide which buckets a user gets.
    for (const [label, sql] of s.ctes) {
      const t = tokens(sql);
      if (!t || readsToken(t) || readsClient(t)) continue;
      add(
        sql,
        hasWhere(t),
        [s.name],
        `bucket ${s.name}, ${label} reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists${hasWhere(t) ? " that its fixed filters allow" : ""}`,
      );
    }
    // Data queries that read no bucket parameter send every row to every user the bucket reaches.
    const open = s.queries.map((q) => ({ q, t: tokens(q.sql) })).filter((x) => x.t && !readsBucket(x.t));
    const first = open[0];
    if (!first) continue;
    const tables = [...new Set(open.map((x) => tableOf(x.q.sql)))];
    const filtered = open.every((x) => x.t && hasWhere(x.t));
    const what = tables.length > 3 ? `${tables.slice(0, 3).join(", ")} and ${tables.length - 3} more tables` : tables.join(", ");
    const allowed = filtered ? " that their fixed filters allow" : "";
    add(
      first.q.sql,
      filtered,
      [s.name, ...tables],
      s.ctes.size
        ? `bucket ${s.name}: ${open.length === s.queries.length ? "its data queries read" : `${open.length} of its data queries read`} no bucket parameter, so every user it reaches receives every row of ${what}${allowed}`
        : `bucket ${s.name} has no parameter query, so every user receives every row of ${what}${allowed}`,
    );
  }
  return out;
});
