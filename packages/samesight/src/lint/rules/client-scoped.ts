/**
 * client-scoped: rows picked by what the client sends, with nothing checking who is asking.
 *
 * Subscription and connection parameters (streams), request.parameters() and
 * user_parameters (sync rules) are whatever the app passes, so whatever anyone passes. A
 * stream query, or a sync rules parameter query, that reads one and no token value lets any
 * client ask for any rows. Reading both is fine: the token value bounds what can be asked.
 */

import type { LintFinding } from "../finding.ts";
import type { LintRule } from "../lint.ts";
import { inNames, readsClient, readsToken, tableOf, tokens } from "../sql.ts";

const RULE = "client-scoped";

export const clientScoped: LintRule = ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const add = (sql: string, subjects: string[], message: string) => out.push({ rule: RULE, level: "error", file, line: lineOf(sql), message, subjects });

  for (const s of config.streams) {
    if (config.kind === "streams") {
      const ctes = new Map([...s.ctes].map(([name, sql]) => [name.toLowerCase(), tokens(sql)]));
      for (const q of s.queries) {
        const t = tokens(q.sql);
        if (!t) continue;
        const read = [t, ...inNames(t).filter((n) => ctes.has(n)).map((n) => ctes.get(n))];
        if (read.some((x) => x === null)) continue;
        const all = read as NonNullable<(typeof read)[number]>[];
        if (!all.some(readsClient) || all.some(readsToken)) continue;
        add(
          q.sql,
          [s.name, tableOf(q.sql)],
          `stream ${s.name}, ${q.label} picks its ${tableOf(q.sql)} rows by a parameter the client sends, and nothing checks the requesting user, so any client can ask for any of them`,
        );
      }
      continue;
    }
    for (const [label, sql] of s.ctes) {
      const t = tokens(sql);
      if (!t || !readsClient(t) || readsToken(t)) continue;
      add(sql, [s.name], `bucket ${s.name}, ${label} takes its bucket parameters from what the client sends, and nothing checks the requesting user, so any client can ask for any bucket`);
    }
  }
  return out;
};
