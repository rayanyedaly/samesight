/**
 * rls-open: a policy on a synced table that lets everyone through, `using (true)` or
 * `with check (true)`, for anon, authenticated or public. PowerSync replicates past RLS,
 * so the sync config may well send less; the Supabase API serves what the policy allows.
 * Policies for other roles (supabase_auth_admin, service roles) are not this rule's.
 */

import type { LintFinding } from "../finding.ts";
import type { LintRule } from "../lint.ts";
import type { Policy } from "../migrations.ts";
import { sentTables } from "../sql.ts";

const RULE = "rls-open";
const CLIENT_ROLES = ["anon", "authenticated", "public"];
const WHO: Record<string, string> = { anon: "anyone with the anon key", authenticated: "every signed-in user", public: "every client, signed in or not," };

/** "a", "a and b", "a, b and c". */
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const isTrue = (expr: string | null) => expr !== null && expr.replace(/[\s()]/g, "").toLowerCase() === "true";

/** What the always-true clauses let through, given the policy's command. */
function opens(p: Policy): string[] {
  const out: string[] = [];
  const reads = p.command === "all" || p.command === "select";
  if (isTrue(p.using)) {
    if (reads) out.push("read every row");
    if (p.command === "all" || p.command === "update") out.push("update every row");
    if (p.command === "all" || p.command === "delete") out.push("delete every row");
  }
  if (isTrue(p.check) && (p.command === "all" || p.command === "insert" || p.command === "update")) out.push("write rows with any values");
  return out;
}

export const rlsOpen: LintRule = ({ file, config, migrations, lineOf }) => {
  if (!migrations) return [];
  const out: LintFinding[] = [];
  for (const [table, sql] of sentTables(config)) {
    for (const p of migrations.policies.get(table) ?? []) {
      const who = p.roles.filter((r) => CLIENT_ROLES.includes(r));
      const what = opens(p);
      if (!who.length || !what.length) continue;
      out.push({
        rule: RULE,
        level: "warning",
        file,
        line: lineOf(sql),
        message: `policy "${p.name}" on ${table} (${p.file}:${p.line}) lets ${list(who.map((r) => WHO[r] as string))} ${list(what)} through the Supabase API, whatever the sync config sends`,
      });
    }
  }
  return out;
};
