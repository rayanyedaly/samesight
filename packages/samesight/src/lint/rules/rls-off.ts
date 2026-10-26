/**
 * rls-off: a table the sync config sends whose migrations never turn row level security
 * on. PowerSync replicates past RLS, so devices are unaffected; the risk is the Supabase
 * API, which with Supabase's default grants lets any client holding the public anon key
 * read and change every row of a public table without RLS. Read from the migrations
 * (see migrations.ts), so a table whose RLS is switched on some other way is reported too.
 */

import type { LintRule } from "../lint.ts";
import { sentTables } from "../sql.ts";

const RULE = "rls-off";

export const rlsOff: LintRule = ({ file, config, migrations, lineOf }) => {
  if (!migrations) return [];
  return [...sentTables(config)]
    .filter(([table]) => !migrations.rls.has(table))
    .map(([table, sql]) => ({
      rule: RULE,
      level: "warning" as const,
      file,
      line: lineOf(sql),
      message: `${table} is synced, but the migrations never enable row level security on it, so with Supabase's default grants any client can read and change every row through the API`,
    }));
};
