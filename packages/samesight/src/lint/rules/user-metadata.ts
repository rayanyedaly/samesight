/**
 * user-metadata: access decided by the token's user_metadata.
 *
 * Supabase puts user_metadata in the token, and every user can set their own
 * (supabase.auth.updateUser), so whatever access it grants, anyone can grant themselves.
 * app_metadata, which only the server sets, or a table is the place for it. A read of it
 * from the token counts anywhere in a stream CTE or sync rules parameter query, and in the
 * conditions (WHERE, JOIN ON) of a query whose rows are synced: auth.parameter(
 * 'user_metadata') or a path into it ('user_metadata.role'), auth.parameters() or
 * request.jwt() -> 'user_metadata'. See readsUserMetadata.
 */

import { conditions } from "../access.ts";
import type { LintFinding } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";
import { readsUserMetadata, tokens } from "../sql.ts";

const RULE = "user-metadata";

export const userMetadata: LintRule = defineRule(RULE, ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const kind = config.kind === "streams" ? "stream" : "bucket";
  for (const s of config.streams) {
    // A CTE or parameter query decides access with whatever it reads or selects; a query whose
    // rows are synced only with what its conditions read. Selecting the claim is no leak.
    const deciding = [...s.ctes].map(([label, sql]) => ({ label: config.kind === "streams" ? `with.${label}` : label, sql, all: true }));
    for (const q of [...deciding, ...s.queries.map((q) => ({ ...q, all: false }))]) {
      const t = tokens(q.sql);
      if (!t || !(q.all ? readsUserMetadata(t) : conditions(t).some(readsUserMetadata))) continue;
      out.push({
        rule: RULE,
        level: "error",
        file,
        line: lineOf(q.sql),
        subjects: [s.name],
        message: `${kind} ${s.name}, ${q.label} decides access from user_metadata, which every Supabase user can set on themselves (supabase.auth.updateUser); use app_metadata or a table`,
      });
    }
  }
  return out;
});
