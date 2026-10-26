/**
 * user-metadata: access decided by the token's user_metadata.
 *
 * Supabase puts user_metadata in the token, and every user can set their own
 * (supabase.auth.updateUser), so whatever access it grants, anyone can grant themselves.
 * app_metadata, which only the server sets, or a table is the place for it. A read of it
 * from the token in a stream query, CTE or sync rules query counts: auth.parameter(
 * 'user_metadata') or a path into it ('user_metadata.role'), auth.parameters() or
 * request.jwt() -> 'user_metadata'. See readsUserMetadata.
 */

import type { LintFinding } from "../finding.ts";
import type { LintRule } from "../lint.ts";
import { readsUserMetadata, tokens } from "../sql.ts";

const RULE = "user-metadata";

export const userMetadata: LintRule = ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const kind = config.kind === "streams" ? "stream" : "bucket";
  for (const s of config.streams) {
    const queries = [...[...s.ctes].map(([label, sql]) => ({ label: config.kind === "streams" ? `with.${label}` : label, sql })), ...s.queries];
    for (const q of queries) {
      const t = tokens(q.sql);
      if (!t || !readsUserMetadata(t)) continue;
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
};
