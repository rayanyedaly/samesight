/**
 * client-scoped: rows picked by what the client sends, with nothing tying them to who is asking.
 *
 * Subscription and connection parameters (streams), request.parameters() and
 * user_parameters (sync rules) are whatever the app passes, so whatever anyone passes. A
 * stream query limited by one and by no token value, or a sync rules parameter query whose
 * bucket parameters come from one and are not bounded by the token, lets any client ask for
 * any rows. A row compared with a token value too bounds what can be asked, and makes it
 * fine; one in an OR branch beside the client value does not (see access.ts). A check on
 * a token claim (a role) beside the client value makes it a warning: only users who pass
 * can ask, for any row.
 */

import { bucketAccess, streamAccess } from "../access.ts";
import type { LintFinding } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";
import { inNames, tableOf, tokens } from "../sql.ts";

const RULE = "client-scoped";

export const clientScoped: LintRule = defineRule(RULE, ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const add = (sql: string, subjects: string[], message: string) => out.push({ rule: RULE, level: "error", file, line: lineOf(sql), message, subjects });

  for (const s of config.streams) {
    if (config.kind === "streams") {
      for (const q of s.queries) {
        const t = tokens(q.sql);
        if (!t) continue;
        const read = inNames(t);
        if ([...s.ctes].some(([k, sql]) => read.includes(k.toLowerCase()) && !tokens(sql))) continue;
        const access = streamAccess(q.sql, s.ctes);
        if (!access?.tokenOrClient || access.token) continue;
        const table = tableOf(q.sql);
        if (access.claim) {
          out.push({
            rule: RULE,
            level: "warning",
            file,
            line: lineOf(q.sql),
            subjects: [s.name, table],
            message: `stream ${s.name}, ${q.label} picks which rows of ${table} it sends by a parameter the client sends; only users who pass its check on who is asking (a role claim, or a list such as admins) can ask, and they can ask for any of them; fine if that is meant`,
          });
          continue;
        }
        add(q.sql, [s.name, table], `stream ${s.name}, ${q.label} picks which rows of ${table} it sends by a parameter the client sends, and nothing limits them to the requesting user, so any client can ask for any of them`);
      }
      continue;
    }
    for (const p of bucketAccess(s.ctes, s.queries).loose.filter((p) => p.via === "client")) {
      add(p.sql, [s.name], `bucket ${s.name}, ${p.label} takes its bucket parameters from what the client sends, and nothing limits them to the requesting user, so any client can ask for any bucket`);
    }
  }
  return out;
});
