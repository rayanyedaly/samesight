# Changelog

All four packages (`samesight`, `@samesight/verify`, `@samesight/supabase`, `@samesight/next`) share one version. Before 1.0, a minor version may change the policy language or the generated output; each such change is listed here with what to do.

## 0.1.0

The first published release.

### samesight

- The policy language: `definePolicy<Database>` with claims, a membership table and per-table rules (`read`, `write`, `insert`, `update`, `delete`, `check`) built from `col`, `via`, `rowsOf`, `and`, `or` and `raw`; column options `hide`, `serverOwned`, `immutable`, `author`, `touch` and `appendOnly`; `rejectedWrites`, `output` and `client`.
- A compiler that checks the policy against the live schema and refuses, with the rule named, whatever RLS and sync streams cannot both express.
- `samesight generate`: the Supabase migration (RLS, column grants, the access token hook, append-only and `touch` triggers, the replication role and publication, `apply_batch` and `record_rejection`), Edition 3 sync streams, a local PowerSync service config, the client schema, policy types, a manifest and a schema snapshot.
- `samesight check` for CI, with no database; `samesight doctor` against the local database.
- `samesight init` drafts a compiling policy from the local database: the membership and tenant tables, each table's tenant column and the role values. Without a database it writes a template.
- `samesight explain` prints the compiled policy in plain words: a role by operation matrix, each rule, the columns clients write and those each role never receives.
- Policy files load as `samesight.policy.ts` or `samesight.policy.mts`, with a clear error for a CommonJS package and for Node without TypeScript support.
- Connects only to a database on this machine, found from the `[db]` port in `supabase/config.toml` unless `--db` says otherwise.
- `apply_batch` treats a PUT whose row exists as a replay: it updates the row where the caller may (last write wins) and otherwise leaves it, so a role that may insert a row but not update it can still replay its own insert after a lost acknowledgement.

### @samesight/verify

- `samesight-verify`: static checks, catalog checks with migration parity, the differential test on real users and headless PowerSync devices, forged upload batches, and the mutation test (`--mutate`).
- `samesight-verify audit` for projects with hand-written RLS and a hand-written sync config, with no policy. It reads sync streams and legacy sync rules (`bucket_definitions`), and warns about bucket definitions that read client parameters.
- Finds the Supabase CLI in the nearest `node_modules/.bin` or on the PATH, with any package manager.
- Generated data fills uuid columns that default to `auth.uid()` with the run's users, foreign key or not, and a table that gets no rows says what the database refused.
- The offline checks are exported for use in tests.

### @samesight/supabase

- `SupabaseConnector`: one `apply_batch` call per transaction, failures sorted into retry, reauth, stuck and reject, refused writes recorded locally before they leave the queue, and no uploads under another user's session.
- `latestOnly` and `earlierVersions` for append-only tables with superseding corrections; `pendingUploadCount` and `hasUnsyncedWrites`.

### @samesight/next

- `createEncryptedStore`: a per-user encrypted PowerSync database keyed from the sign-in password.
- `SamesightProvider` and `useSamesight`: offline unlock, idle lock, sign-out that counts the queue, and a recovery screen that names the loss.
- `SyncStatusChip`, `RejectedWritesBanner`, `ConfirmDialog` and `styles.css`.
