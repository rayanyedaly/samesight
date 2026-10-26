/**
 * unscoped-query: rows every user receives, because nothing ties them to who is asking.
 *
 * A token value counts only where it limits rows (see access.ts): `owner_id =
 * auth.user_id() OR true` reads the token and still sends every row.
 *
 * - A stream query no token or client value limits, directly or through a CTE it reads.
 * - A sync rules data query no bucket parameter limits: every user the bucket reaches gets
 *   every row (a bucket with no parameter query reaches everyone).
 * - A sync rules parameter query whose bucket parameters, as the data queries use them,
 *   come from neither the token nor the client: it hands its buckets to every user.
 *
 * Unfiltered, it is an error. Filtered only by fixed values (status = 'public'), it is a
 * warning: often public data by design. So are open data queries in a bucket whose every
 * parameter query admits only users passing a fixed check on their own row or token (a
 * role, such as admins). Queries the client alone limits are client-scoped's to report.
 */

import type { Token } from "../../sync/sql.ts";
import { bucketAccess, filtered, streamAccess } from "../access.ts";
import type { LintFinding } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";
import { inNames, readsClient, readsToken, tableOf, tokens } from "../sql.ts";

const RULE = "unscoped-query";

/** What a query reads that might have tied it to the user, for messages. */
function reads(t: Token[][]): string | undefined {
  if (t.some(readsToken)) return "the requesting user's token";
  if (t.some(readsClient)) return "a parameter the client sends";
  return undefined;
}

export const unscopedQuery: LintRule = defineRule(RULE, ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const add = (sql: string, warning: boolean, subjects: string[], message: string) =>
    out.push({ rule: RULE, level: warning ? "warning" : "error", file, line: lineOf(sql), message, subjects });

  for (const s of config.streams) {
    if (config.kind === "streams") {
      for (const q of s.queries) {
        const t = tokens(q.sql);
        if (!t) continue;
        const read = inNames(t);
        const cteTokens = [...s.ctes].filter(([k]) => read.includes(k.toLowerCase())).map(([, sql]) => tokens(sql));
        if (cteTokens.some((c) => c === null)) continue;
        const access = streamAccess(q.sql, s.ctes);
        if (!access || access.tokenOrClient) continue;
        const table = tableOf(q.sql);
        const what = reads([t, ...(cteTokens as Token[][])]);
        const filter = filtered(q.sql, s.ctes);
        const gets = filter ? "the same rows, filtered only by fixed values" : "every row";
        add(
          q.sql,
          filter,
          [s.name, table],
          what
            ? `stream ${s.name}, ${q.label} reads ${what}, but not in a way that limits its ${table} rows, so every user gets ${gets}`
            : filter
              ? `stream ${s.name}, ${q.label} sends every user the same ${table} rows, filtered only by fixed values; fine if they are public by design`
              : `stream ${s.name}, ${q.label} sends every ${table} row to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim`,
        );
      }
      continue;
    }

    // Sync rules: the parameter queries decide which buckets a user gets.
    const access = bucketAccess(s.ctes, s.queries);
    for (const p of access.loose.filter((p) => p.via === "nobody")) {
      const t = tokens(p.sql) as Token[];
      const what = reads([t]);
      const filter = filtered(p.sql);
      add(
        p.sql,
        filter,
        [s.name],
        what
          ? `bucket ${s.name}, ${p.label} reads ${what}, but not in a way that limits which buckets it gives, so every user gets every bucket it lists${filter ? " that its fixed filters allow" : ""}`
          : `bucket ${s.name}, ${p.label} reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists${filter ? " that its fixed filters allow" : ""}`,
      );
    }
    const open = access.open;
    const first = open[0];
    if (!first) continue;
    const tables = [...new Set(open.map((q) => tableOf(q.sql)))];
    const filter = open.every((q) => filtered(q.sql));
    const what = tables.length > 3 ? `${tables.slice(0, 3).join(", ")} and ${tables.length - 3} more tables` : tables.join(", ");
    const allowed = filter ? " that their fixed filters allow" : "";
    const which = open.length === s.queries.length ? "its data queries are" : `${open.length} of its data queries are`;
    add(
      first.sql,
      filter || access.roleGated,
      [s.name, ...tables],
      !s.ctes.size
        ? `bucket ${s.name} has no parameter query, so every user receives every row of ${what}${allowed}`
        : access.roleGated
          ? `bucket ${s.name}: ${which} not limited by a bucket parameter, so every user its parameter queries admit receives every row of ${what}${allowed}; fine if they admit only a role (such as admins) meant to see it all`
          : `bucket ${s.name}: ${which} not limited by a bucket parameter, so every user it reaches receives every row of ${what}${allowed}`,
    );
  }
  return out;
});
