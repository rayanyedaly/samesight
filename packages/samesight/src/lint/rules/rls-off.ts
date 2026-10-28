/**
 * rls-off: a table the sync config sends whose migrations never turn row level security
 * on. PowerSync replicates past RLS, so devices are unaffected; the risk is the Supabase
 * API, which lets any client holding the public anon key read and change every row of a
 * public table without RLS, unless the table's grants to anon and authenticated were
 * revoked. Read from the migrations
 * (see migrations.ts), so a table whose RLS is switched on some other way is reported too.
 */

import { defineRule, type LintRule } from "../lint.ts";
import { sentTables } from "../sql.ts";

const RULE = "rls-off";

export const rlsOff: LintRule = defineRule(RULE, ({ file, config, migrations, lineOf }) => {
  if (!migrations) return [];
  return [...sentTables(config)]
    .filter(([table]) => !migrations.rls.has(table))
    .map(([table, sql]) => ({
      rule: RULE,
      level: "warning" as const,
      file,
      ...lineOf(sql),
      subjects: [table],
      message: `${table} is synced, but the migrations never enable row level security on it, so unless its grants to anon and authenticated were revoked, any client can read and change every row through the Supabase API`,
    }));
});
