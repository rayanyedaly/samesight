# Changelog

All four packages (`samesight`, `@samesight/verify`, `@samesight/supabase`, `@samesight/next`) share one version. Before 1.0, a minor version may change the policy language or the generated output; each such change is listed here with what to do.

## 0.1.0

The first published release.

### samesight

- The policy language: `definePolicy<Database>` with claims, a membership table and per-table rules (`read`, `write`, `insert`, `update`, `delete`, `check`) built from `col`, `via`, `rowsOf`, `and`, `or` and `raw`; column options `hide`, `serverOwned`, `immutable`, `author`, `touch` and `appendOnly`; `rejectedWrites`, `output` and `client`.
- A compiler that checks the policy against the live schema and refuses, with the rule named, whatever RLS and sync streams cannot both express.
- `samesight generate`: the Supabase migration (RLS, column grants, the access token hook, append-only and `touch` triggers, the replication role and publication, `apply_batch` and `record_rejection`), Edition 3 sync streams, a local PowerSync service config, the client schema, policy types, a manifest and a schema snapshot.
- `samesight check` for CI, with no database; `samesight doctor` against the local database and `supabase/config.toml` (the access token hook turned on, an Auth signing key).
- Read rules can go through another table with `col("id").in(rowsOf("project_members", "project_id", col("user_id").eq(claim.user)))`, for sharing and assignment tables: a CTE in the streams, a subquery under that table's RLS in Postgres.
- Shared tables: `tenant: null` for reference data every tenant reads the same way (plans, countries, labels). Role-gated, never tenant-gated, and read-only to clients.
- `samesight lint` checks any PowerSync sync config (sync streams or sync rules), and the project's SQL migrations when present, for known leak patterns, with no database, PowerSync or policy file: rows every user receives (`unscoped-query`), rows picked by client parameters (`client-scoped`), access decided by `user_metadata`, queries audit cannot check (one device table name holding two tables' rows included), on-demand streams audit does not test, synced tables without RLS (`rls-off`) and policies that let any client or any signed-in user through (`rls-open`). `--allow` accepts a deliberate finding, `--format json` is for CI.
- Each lint rule has a summary, a description, a level and a link to its own heading in `docs/cli.md` (`RULE_INFO`). Findings carry the column a query starts at besides its line, and `--format json` gives it as `column`.
- `samesight init` drafts a compiling policy from the local database: the membership and tenant tables, each table's tenant column and the role values. Without a database it writes a template.
- `samesight explain` prints the compiled policy in plain words: a role by operation matrix, each rule, the columns clients write and those each role never receives.
- Policy files load as `samesight.policy.ts` or `samesight.policy.mts`, with a clear error for a CommonJS package and for Node without TypeScript support.
- `claimReads` (from `samesight/compiler`) finds the token claims a piece of SQL reads, in RLS as Postgres prints it, in sync streams and in sync rules, and what each is compared with: literals, a column, or something it names but cannot follow. `classify` says who sets a claim (Auth, the app's `app_metadata`, the user's `user_metadata`, an access token hook).
- `claimReads` reads array slices (`(tags)[1:2]`), three-part names (`public.t.col`, `x.y.f()`) and every numeric constant (`1e3`, `.5`, `1.`), and refuses a table named with its database by name. A literal compared with a read cast to a number is that number (`'01'` is `1`) where a double holds it exactly. Overloads that differ only by argument type are reported as several bodies. `canonicalNumber` and `BODY_JOIN` are exported.
- `client_id` is reserved as a claim name: Supabase Auth sets it on tokens an OAuth client gets.
- Every `samesight` command exits 0 on a pass, 1 when it found something (a policy that does not compile among them), and 2 when it could not run.
- Connects only to a database on this machine, found from the `[db]` port in `supabase/config.toml` unless `--db` says otherwise.
- `apply_batch` treats a PUT whose row exists as a replay or an upsert: it updates the row where the caller may (last write wins) and otherwise leaves it, without ever putting it through the INSERT policy. It returns the number of ops it applied, and decodes json, jsonb and array values that PowerSync clients hold as text.
- The compiler refuses what RLS and the streams would read differently: generated columns in read rules (logical replication does not send them), literals on arrays, json, citext and char(n), `real` literals a 4-byte float cannot hold, partitioned tables, and non-uuid ids or unquotable column names on tables clients write. A `powersync` publication made `FOR ALL TABLES` is replaced rather than failing the migration.

### @samesight/verify

- `samesight-verify`: static checks, catalog checks with migration parity, the differential test on real users and headless PowerSync devices, forged upload batches, and the mutation test (`--mutate`).
- `samesight-verify audit` for projects with hand-written RLS and a hand-written sync config, with no policy. It reads sync streams and legacy sync rules (`bucket_definitions`), and warns about bucket definitions that read client parameters.
- Audit starts its own PowerSync service when `--powersync` is not given, once the sync config and catalog checks pass, so it needs only `supabase start` and Docker: a temporary replication role, a throwaway storage container and the pinned PowerSync image on the Supabase network, all removed when the run ends (Ctrl+C, SIGTERM, SIGHUP and a closed output included), and swept by the next audit that starts PowerSync after a crash. `--keep-powersync` leaves it up for the next run to reuse.
- Finds the Supabase CLI in the nearest `node_modules/.bin` or on the PATH, with any package manager.
- Generated data fills uuid columns that default to `auth.uid()` with the run's users, foreign key or not, and a table that gets no rows says what the database refused.
- The write path forges, for each role, the inserts, updates and deletes in its own tenant that the policy gives it no rule for.
- A row sent by two streams is compared copy by copy; values come from enum labels and from the literals in hand-written policies and stream queries; defaulted columns are sometimes left to their default; tables still untested get up to three more targeted datasets.
- The static checks fail when the generated files are not what the policy generates now, and the catalog checks when the database no longer matches the schema snapshot.
- Audit mode warns about policies and stream queries that read `user_metadata`, and about streams that read client parameters.
- Audit reads which token claims the policies (through SQL wrapper functions, two levels deep, and by argument count for overloads) and the sync config read, and gives its run users the `app_metadata` and `user_metadata` values they compare: each literal, a value none matches, and none at all, in every combination that fits in at most eight users; claims compared with columns (an org id) get values generated rows hold too, as keys or column values. The Claims section says who holds what, and why any other claim (one audit cannot follow, say) is not tested. A claim compared with a key to `auth.users` gets two run users' ids, which run users are created with.
- Audit's Coverage section says whether each RLS read policy and each stream was seen both allowing and refusing a run user a row, measured inside transactions that are always rolled back, and names each rule seen only one way with the reason; the Differential line says how many rules were not tested both ways. More datasets run while a rule could still be exercised.
- Audit steers the claims a `pg-functions://` access token hook adds: it reads the hook's function and the public tables it reads, gives run users rows in those with a column pointing at `auth.users` before they sign in (every user but the last, or some and not others), varied over the rows their keys point at, their CHECK or enum list and the literals rules compare, jointly with the metadata values, keeps those rows for the run, and says who holds each claim the hook adds. It warns when the hook's role may not read those tables, when the hook writes, calls out, runs dynamic SQL or sets metadata in the token, and names a hook it cannot steer with the reason.
- Audit reads a query whose output table has an alias (`FROM documents d`), mapping the device table PowerSync names after it back to the source.
- A run stopped by Ctrl+C, SIGTERM, SIGHUP or a closed output removes its users and rows too, not only the PowerSync service it started.
- A sync config the PowerSync service refuses fails the start in seconds with the service's last log lines, and a device sync gives up once it has stayed unconnected to a failing service for 10 seconds.
- A 429 from Supabase Auth at sign-in names the `[auth.rate_limit] sign_in_sign_ups` setting to raise.
- Audit compares a claim's values as numbers where every rule reads it as one, and puts a claim read as text into number columns only as Postgres prints it back.
- Columns compared with a claim an access token hook adds take the values the hook can add in generated rows. Audit warns when `anon` or `authenticated` can execute the hook, and on functions it calls three or more calls deep; a helper's select whose list has `*`, `t.*`, or `to_jsonb`, `to_json`, `row_to_json` or `hstore` of a table it reads counts as reading every column of the tables it reads. The warning gives the grants and the revoke Supabase's guide runs, with names quoted. With a hook enabled, `client_id`, `jti` and `nbf` count as the hook's claims.
- Cleanup also removes an earlier run's rows from tables beyond this run's (an access token hook's, from a run made while it was on), as the project's own deletes would; a row there goes only when every owner it must have is a run user. There, and in tables without a single key, a row only an optional column ties to a run user stays.
- Policy mode removes its users and rows on Ctrl+C, SIGTERM, SIGHUP or a closed output, as audit does, and with `--mutate` puts the sync config back and restarts PowerSync as part of that; Ctrl+Break (SIGBREAK) counts on Windows. A stop that cannot finish says what is left and which run removes it.
- A differential failure prints a block per row: what happened (`leak`, `hidden`, `gap`, `unsent`, `differs`), the user and their claims, the row with its tenant and the users it holds, and the stream that sent it, with the query (label and SQL) that sent it: the stream's only query for the table, or else the ones that return the row when run as that user, and the RLS policies that refuse a leaked row or allow a row no stream sent. With sync streams (not sync rules), a leak a stream query sends without the owner filter its only policy has (`column = auth.uid()`) comes with the filter to add, checked against the row, unless another stream has the same query. Findings carry these as `rows` (`RowReport`, exported).
- A differential counterexample ends with a `replay` line: the command that replays the run, with its own flags and the seed that failed, shell-quoted. A run without `--seed` picks one from 0 to 2147483644, the range `--seed` takes. Findings carry it as `replay`.
- `samesight-verify` prints in colour, with a symbol before each `FAIL`, `warn` and `ok`, when its output is a terminal; it stays plain when piped, in CI, under `TERM=dumb` or under `NO_COLOR`, and `FORCE_COLOR` turns colour on. `formatFindings` takes a `color` argument, off by default.
- `samesight-verify` exits 0 on a pass, 1 when a check found something, and 2 when it could not run (a flag, a missing file, a database or service it cannot reach, a differential whose service broke down), so CI can tell a leak from a broken run.
- `--json` (both modes) writes one JSON report to stdout, with the text on stderr, on exits 0, 1 and 2: the result and exit code, the `--seed` given, each section's findings and the differential's row reports. Its JSON Schema ships as `@samesight/verify/schema/report.schema.json`.
- `--report <file>` writes the findings as Markdown for an issue: a heading per row with a table of who received it, what sent it, which policies decided and the likely fix, the query's SQL in a `sql` block and the replay command. It is written on exits 0, 1 and 2, with the error on 2.
- The offline checks are exported for use in tests.

### @samesight/supabase

- `SupabaseConnector`: one `apply_batch` call per transaction, taken out of the queue only when `apply_batch` confirms how many ops it applied; failures sorted into retry, reauth, stuck and reject, where only Postgres's judgements on the data (constraints, RLS, `apply_batch` refusals) reject and anything else is held; `onStuck` for batches that keep failing; refused writes recorded locally before they leave the queue; no uploads under another user's session.
- `latestOnly` and `earlierVersions` for append-only tables with superseding corrections; `pendingUploadCount` and `hasUnsyncedWrites`.

### @samesight/next

- `createEncryptedStore`: a per-user encrypted PowerSync database keyed from the sign-in password.
- `SamesightProvider` and `useSamesight`: offline unlock, an idle lock that also counts time the device slept, sign-out that counts the queue and unacknowledged refused writes, and a recovery screen that names the loss.
- `SyncStatusChip`, `RejectedWritesBanner`, `ConfirmDialog` and `styles.css`.
