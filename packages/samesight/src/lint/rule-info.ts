/**
 * What each lint rule is, for reports that describe their rules (SARIF): a one-line
 * summary, a few sentences on what it catches, its level and where its docs are.
 */

import type { LintLevel } from "./finding.ts";

export interface RuleInfo {
  /** One line. */
  summary: string;
  /** A few sentences on what the rule catches and why it matters. */
  description: string;
  /** The rule's level; for rules whose level varies by finding, the highest it gives. */
  level: LintLevel;
  /**
   * The rule's page on the docs site, built from docs/rules/<id>.md: an example, what lint
   * prints on it, the fix and what audit does with it. 0.1.0 linked to the rule's heading
   * in docs/cli.md instead, which stays for those links.
   */
  help: string;
}

const DOCS = "https://rayanyedaly.github.io/samesight/rules";

const rule = (id: string, level: LintLevel, summary: string, description: string): [string, RuleInfo] => [id, { summary, description, level, help: `${DOCS}/${id}` }];

/** Keyed by rule name, in the order lint runs the rules. */
export const RULE_INFO: Readonly<Record<string, RuleInfo>> = Object.fromEntries([
  rule(
    "unscoped-query",
    "error",
    "Rows every user receives, because nothing ties them to who is asking.",
    "A stream query no token or client value limits, a sync rules data query no bucket parameter limits, or a parameter query whose bucket parameters come from neither the token nor the client sends its rows to every user. A token value counts only where a row is compared with it, so owner_id = auth.user_id() OR true still sends every row. It is an error when nothing filters the rows, and a warning when fixed values or a check on who is asking (a role claim, an admin list) do.",
  ),
  rule(
    "client-scoped",
    "error",
    "Rows picked by what the client sends, with nothing tying them to who is asking.",
    "Subscription and connection parameters, request.parameters() and user_parameters are whatever the app passes, so whatever anyone passes. A query limited by one and by no token value lets any client ask for any rows. Beside a check on who is asking (a role claim, an admin list) it is a warning: only users who pass can ask, for any row.",
  ),
  rule(
    "user-metadata",
    "error",
    "Access decided by the token's user_metadata, which every user can set on themselves.",
    "Supabase puts user_metadata in the token, and every user can set their own with supabase.auth.updateUser, so whatever access it grants, anyone can grant themselves. A read of it counts in a stream CTE or sync rules parameter query, and in the conditions of a query whose rows are synced. Use app_metadata, which only the server sets, or a table.",
  ),
  rule(
    "unreadable-query",
    "warning",
    "A query samesight-verify audit cannot attribute to one table, so it cannot check it.",
    "The audit refuses a query it cannot attribute to one table rather than guess what devices hold. The query may be fine, but nothing checks it until it is rewritten into a shape audit reads, such as a qualified projection or [INNER] JOIN ... ON.",
  ),
  rule(
    "not-auto-subscribed",
    "info",
    "A stream devices get only when the app subscribes, which audit does not test.",
    "A stream that is not auto_subscribe reaches a device only when the app subscribes, with parameters the app chooses. Nothing is wrong with that in itself, but audit does not subscribe to it and so does not test it, and what reaches a device depends on what the app, or anyone calling the API, asks for.",
  ),
  rule(
    "rls-off",
    "warning",
    "A synced table whose migrations never enable row level security.",
    "PowerSync replicates past RLS, so devices are unaffected; the risk is the Supabase API, which lets any client holding the public anon key read and change every row of a public table without RLS, unless its grants to anon and authenticated were revoked. Read from the migrations, so a table whose RLS is switched on some other way is reported too.",
  ),
  rule(
    "rls-open",
    "warning",
    "A policy on a synced table that lets any client or any signed-in user through.",
    "A permissive policy with using (true) or with check (true) for anon, authenticated or public lets them read or write every row through the Supabase API, whatever the sync config sends. Policies for other roles and restrictive policies are not reported.",
  ),
  rule(
    "personal-columns",
    "warning",
    "A column that likely holds personal data, sent to users other than the row's owner.",
    "A column whose name says it likely holds personal data (email, phone, date_of_birth), or whose comment marks it so, sent by a query to more users than the row's owner. Lint reads names and comments, never data: names by whole words, and weak words (name, address, notes) only as the whole name of a column in a table named for people (users, members, patients). A comment settles what a name cannot: COMMENT ON COLUMN ... IS 'samesight:personal=<category>' or 'samesight:not-personal'. Comments, primary keys and the columns a SELECT * sends are read from the migrations, so without them only listed columns count and every table is taken to be keyed by id. It warns when a group's members get the column, every user for the rows a fixed filter picks, or every user past a token check that ties no row to them, and notes it when a role check admits the users (often admins), or when any client or every user gets it, which unscoped-query or client-scoped usually fails already.",
  ),
]);
