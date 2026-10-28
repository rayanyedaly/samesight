/**
 * unscoped-query: rows every user receives, because nothing ties them to who is asking.
 *
 * A token value counts only where a row is compared with it (see access.ts): `owner_id =
 * auth.user_id() OR true` reads the token and still sends every row.
 *
 * - A stream query no token or client value limits, directly or through a CTE it reads.
 * - A sync rules data query no bucket parameter limits: every user the bucket reaches gets
 *   every row (a bucket with no parameter query reaches everyone).
 * - A sync rules parameter query whose bucket parameters, as the data queries use them,
 *   come from neither the token nor the client: it hands its buckets to every user.
 *
 * Unfiltered, it is an error, and so is a check every signed-in (or non-anonymous) user
 * passes. It is a warning when something else filters the rows: fixed values or a column
 * alone (status = 'public', is_public; often public by design); a check on who is asking,
 * such as a role claim or an admin list (auth.user_id() IN (SELECT user_id FROM admins));
 * both, OR'd (public rows for all, every row for admins); or, for sync rules, a parameter
 * query that gives its buckets by a role claim or lists them by fixed values alone, or a
 * bucket whose parameter queries only admit users passing a fixed check on their own row
 * or a token claim (is_admin = true). Lint cannot tell a role from any other
 * fixed check, so the warning says what to confirm. Queries the client alone limits are
 * client-scoped's.
 */

import type { Token } from "../../sync/sql.ts";
import { bucketAccess, checksClaim, checksEveryToken, filtered, fixedFiltered, streamAccess } from "../access.ts";
import type { LintFinding } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";
import { readsClient, readsToken, sources, tableOf, tokens } from "../sql.ts";

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
    out.push({ rule: RULE, level: warning ? "warning" : "error", file, ...lineOf(sql), message, subjects });

  for (const s of config.streams) {
    if (config.kind === "streams") {
      for (const q of s.queries) {
        const t = tokens(q.sql);
        if (!t) continue;
        const ctes = [...s.ctes].filter(([k]) => sources(t).has(k.toLowerCase()));
        const cteTokens = ctes.map(([, sql]) => tokens(sql));
        if (cteTokens.some((c) => c === null)) continue;
        const access = streamAccess(q.sql, s.ctes);
        if (!access || access.tokenOrClient) continue;
        const table = tableOf(q.sql);
        const where = `stream ${s.name}, ${q.label}`;
        if (access.claim) {
          const rows = access.filtered ? `the rows of ${table} its fixed filters allow` : `every row of ${table}`;
          add(
            q.sql,
            true,
            [s.name, table],
            `${where} sends ${rows} to every user who passes its check on who is asking (a role claim, or a list such as admins), not each user their own; fine if only users meant to see them all pass it`,
          );
          continue;
        }
        if (access.filtered) {
          add(q.sql, true, [s.name, table], `${where} sends every user the rows of ${table} its fixed filters allow, whatever their token says; fine if those are public by design`);
          continue;
        }
        if (access.filteredOrClaim) {
          add(
            q.sql,
            true,
            [s.name, table],
            `${where} sends every user the rows of ${table} its fixed filters allow, and every row to users who pass its check on who is asking (a role claim, or a list such as admins); fine if those rows are public and only users meant to see them all pass the check`,
          );
          continue;
        }
        const what = reads([t, ...(cteTokens as Token[][])]);
        add(
          q.sql,
          false,
          [s.name, table],
          [q.sql, ...ctes.map(([, sql]) => sql)].some(checksEveryToken)
            ? `${where} checks a claim every signed-in Supabase user passes (role or aud = 'authenticated') or every non-anonymous one (is_anonymous = false), so every user gets every row of ${table}`
            : what
              ? `${where} reads ${what}, but not in a way that limits which rows of ${table} it sends, so every user gets every row`
              : `${where} sends every row of ${table} to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim`,
        );
      }
      continue;
    }

    // Sync rules: the parameter queries decide which buckets a user gets.
    const access = bucketAccess(s.ctes, s.queries);
    for (const p of access.loose.filter((p) => p.via === "nobody")) {
      const t = tokens(p.sql) as Token[];
      const what = reads([t]);
      // The buckets it lists go to everyone, its own rows or not: only fixed values narrow them.
      // A claim every user shares gives every user the same bucket, whatever filters its rows.
      const filter = fixedFiltered(p.sql) && !p.shared;
      if (checksClaim(p.sql)) {
        add(
          p.sql,
          true,
          [s.name],
          `bucket ${s.name}, ${p.label} gives every bucket it lists to every user who passes its check on who is asking (a role claim), not each user their own; fine if only users meant to see them all pass it`,
        );
        continue;
      }
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
    const which = open.length === s.queries.length ? "its data queries are" : `${open.length} of its data queries ${open.length === 1 ? "is" : "are"}`;
    add(
      first.sql,
      filter || access.roleGated,
      [s.name, ...tables],
      !s.ctes.size
        ? `bucket ${s.name} has no parameter query, so every user receives every row of ${what}${allowed}`
        : access.roleGated
          ? `bucket ${s.name}: ${which} not limited by a bucket parameter, so every user its parameter queries admit receives every row of ${what}${allowed}; fine if their checks (such as is_admin = true, or a role claim) admit only users meant to see it all`
          : `bucket ${s.name}: ${which} not limited by a bucket parameter, so every user it reaches receives every row of ${what}${allowed}`,
    );
  }
  return out;
});
