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
- `samesight lint` checks any PowerSync sync config (sync streams or sync rules), and the project's SQL migrations when present, for known leak patterns, with no database, PowerSync or policy file: rows every user receives (`unscoped-query`), rows picked by client parameters (`client-scoped`), access decided by `user_metadata`, queries audit cannot check, on-demand streams audit does not test, synced tables without RLS (`rls-off`) and policies that let any client or any signed-in user through (`rls-open`). `--allow` accepts a deliberate finding, `--format json` is for CI.
- `samesight init` drafts a compiling policy from the local database: the membership and tenant tables, each table's tenant column and the role values. Without a database it writes a template.
- `samesight explain` prints the compiled policy in plain words: a role by operation matrix, each rule, the columns clients write and those each role never receives.
- Policy files load as `samesight.policy.ts` or `samesight.policy.mts`, with a clear error for a CommonJS package and for Node without TypeScript support.
- Connects only to a database on this machine, found from the `[db]` port in `supabase/config.toml` unless `--db` says otherwise.
- `apply_batch` treats a PUT whose row exists as a replay or an upsert: it updates the row where the caller may (last write wins) and otherwise leaves it, without ever putting it through the INSERT policy. It returns the number of ops it applied, and decodes json, jsonb and array values that PowerSync clients hold as text.
- The compiler refuses what RLS and the streams would read differently: generated columns in read rules (logical replication does not send them), literals on arrays, json, citext and char(n), `real` literals a 4-byte float cannot hold, partitioned tables, and non-uuid ids or unquotable column names on tables clients write. A `powersync` publication made `FOR ALL TABLES` is replaced rather than failing the migration.

### @samesight/verify

- `samesight-verify`: static checks, catalog checks with migration parity, the differential test on real users and headless PowerSync devices, forged upload batches, and the mutation test (`--mutate`).
- `samesight-verify audit` for projects with hand-written RLS and a hand-written sync config, with no policy. It reads sync streams and legacy sync rules (`bucket_definitions`), and warns about bucket definitions that read client parameters.
- Audit starts its own PowerSync service when `--powersync` is not given, so it needs only `supabase start` and Docker: a temporary replication role, the publication if the project has none, a throwaway storage container and the pinned PowerSync image on the Supabase network, all removed when the run ends (Ctrl+C included), and swept by the next run after a crash. `--keep-powersync` leaves it up for the next run to reuse.
- Finds the Supabase CLI in the nearest `node_modules/.bin` or on the PATH, with any package manager.
- Generated data fills uuid columns that default to `auth.uid()` with the run's users, foreign key or not, and a table that gets no rows says what the database refused.
- The write path forges, for each role, the inserts, updates and deletes in its own tenant that the policy gives it no rule for.
- A row sent by two streams is compared copy by copy; values come from enum labels and from the literals in hand-written policies and stream queries; defaulted columns are sometimes left to their default; tables still untested get up to three more targeted datasets.
- The static checks fail when the generated files are not what the policy generates now, and the catalog checks when the database no longer matches the schema snapshot.
- Audit mode warns about policies and stream queries that read `user_metadata`, and about streams that read client parameters.
- The offline checks are exported for use in tests.

### @samesight/supabase

- `SupabaseConnector`: one `apply_batch` call per transaction, taken out of the queue only when `apply_batch` confirms how many ops it applied; failures sorted into retry, reauth, stuck and reject, where only Postgres's judgements on the data (constraints, RLS, `apply_batch` refusals) reject and anything else is held; `onStuck` for batches that keep failing; refused writes recorded locally before they leave the queue; no uploads under another user's session.
- `latestOnly` and `earlierVersions` for append-only tables with superseding corrections; `pendingUploadCount` and `hasUnsyncedWrites`.

### @samesight/next

- `createEncryptedStore`: a per-user encrypted PowerSync database keyed from the sign-in password.
- `SamesightProvider` and `useSamesight`: offline unlock, an idle lock that also counts time the device slept, sign-out that counts the queue and unacknowledged refused writes, and a recovery screen that names the loss.
- `SyncStatusChip`, `RejectedWritesBanner`, `ConfirmDialog` and `styles.css`.
