# The verifier

`samesight-verify` answers one question: can any device receive a row that Postgres RLS would refuse to show its user? It answers it by running your real stack, not by reading SQL.

```bash
npx samesight-verify            # static, catalog, differential, write path
npx samesight-verify --mutate   # and the mutation test
npx samesight-verify audit ...  # a project with hand-written RLS and sync streams
```

It needs the project's local stack running: Supabase (`supabase start`) and the PowerSync service. It creates users, writes and deletes rows and, with `--mutate`, restarts PowerSync, so it refuses to run against anything that is not this machine. Every database and HTTP address must be `localhost`, `127.0.0.1` or `::1`, `NODE_ENV` must be `development` or `test`, and variables a hosting platform sets (`VERCEL`, `FLY_APP_NAME`, `KUBERNETES_SERVICE_HOST` and others) must be absent. A port forwarded to a remote database looks local, so never run it through one.

It reads the database URL and keys from `supabase status`, using the Supabase CLI in the nearest `node_modules/.bin` or on your PATH.

## What it runs

### 1. Static checks (no services)

- **Manifest**: the generated migration, sync config and client files are exactly what `samesight generate` wrote.
- **Generated files**: those files are also what the policy generates today, so a policy edited without `samesight generate` fails here instead of verifying the old output.
- **Streams**: every query in the sync config carries the tenant gate, reaches only roles with a read rule, and projects no hidden column.
- **Client schema**: covers every synced table and column.
- **PowerSync version**: the image in your compose file is 1.20.1 or newer (pass `--compose` if the file is not `docker-compose.yml`).

### 2. Catalog checks (the local database)

The live schema matches `samesight/schema.json`, the snapshot the policy was compiled against; RLS is on for every policy table; the policies are exactly the generated ones, by name, command and role; `anon` reaches nothing; `anon` and `authenticated` bypass no RLS and inherit no other role; no view lets them read a protected table past RLS; only Auth can run the token hook; the publication lists exactly the synced tables; append-only tables refuse updates, deletes and truncates. Finally, the latest generated migration is re-applied inside a rolled-back transaction, and anything it would change is named: a hand edit, or a policy added outside the generator.

### 3. The differential test

For every role in two tenants, plus a second user of one role and a user with no membership, it signs up a real Supabase user, and adds a third tenant whose rows nobody in the run may see. [fast-check](https://fast-check.dev) generates datasets across the policy's tables from the schema: foreign keys pick existing parents within the tenant, user columns pick the run's users, and values come from check-constraint lists, enum labels and the literals your rules compare, so every branch of a rule has rows on both sides of it. Columns with a default are sometimes left to it, so a rule that depends on the default is tested too. For each dataset, every user gets a headless `@powersync/node` device that syncs through your PowerSync service, and the verifier reads the same tables through RLS with the same token claims. Then:

- every row a device holds must be one RLS returns that user, with no hidden column; a row two streams send is checked copy by copy, so a wrong copy cannot hide behind a right one;
- every row RLS returns must have reached the device;
- a run where no user received any row of a synced table fails, because it tested nothing. Before failing, it generates up to three more datasets aimed at the tables still untested.

A failure is shrunk to the smallest dataset that still shows it and described in words: which user, which table, which row, and which side had it. `--seed` replays a run exactly.

### 4. The write path

Forged upload batches go through `public.apply_batch` as each user, the way a modified client would send them, each in a transaction that is rolled back: rows claiming another tenant, writes to another tenant's rows, edits and deletes of append-only rows, changes to columns clients may not change, forged authors and server-owned columns, replayed inserts, read-only and unknown tables (including a user promoting their own membership), writes from a user with no membership, and inserts, updates and deletes in a user's own tenant that their role has no rule for. Every forgery must be refused or rewritten. A legitimate insert, replay and update must also go through for each writable table, so a write path that refuses everything fails too.

### 5. The mutation test (`--mutate`)

A passing differential only means something if it would have failed on a broken policy. The mutation test breaks the access layer one rule at a time and requires the differential to notice each break:

- **Sync mutants** drop a stream query's or CTE's tenant gate, role gate or row filter, or project every column where some are hidden. They are loaded together into one sync config and one PowerSync restart.
- **RLS mutants** drop a read policy's tenant gate, widen a role's rule to every row, or remove the rule, inside a rolled-back transaction.

Mutants that provably change nothing (for example, dropping a tenant gate that a composite foreign key already implies) are listed as equivalent, with the reason. Your sync config is restored on every exit path; if PowerSync cannot be restarted on the restored file, the run fails and says where the copy is.

Pass `--restart` if PowerSync is not restarted with `docker compose restart powersync` from the project directory.

## Options

| Option | Default | |
| --- | --- | --- |
| `--policy <file>` | `samesight.policy.ts`, else `.mts` | Paths in the policy are relative to it. |
| `--powersync <url>` | `http://127.0.0.1:8080` | The local PowerSync service. |
| `--compose <file>` | `docker-compose.yml` | For the version floor. |
| `--static` | | Static and catalog checks only. |
| `--runs <n>` | 8 | Datasets for the differential. |
| `--seed <n>` | random | Replay a run. |
| `--time-limit <s>` | 120 | Stop generating datasets after this long. |
| `--mutate` | | Run the mutation test. |
| `--mutate-datasets <n>` | 8 | Datasets to try on each mutant before calling it missed. |
| `--restart <command>` | `docker compose restart powersync` | How to restart PowerSync. |

The exit code is 0 when nothing failed, 1 otherwise. Warnings do not fail a run.

## Audit mode

`samesight-verify audit` runs the same differential on a project that has no Samesight policy: its own RLS (whatever `pg_policies` says) against its own sync config. It is the quickest way to find out whether an existing Supabase and PowerSync app leaks.

```bash
npx @samesight/verify audit \
  --project . \
  --sync-config powersync/sync-config.yaml \
  --powersync http://127.0.0.1:8080 \
  --compose docker-compose.yml
```

What it checks:

- **The sync config**: which tables each query sends. Query shapes it cannot map to one table are refused, never guessed at.
- **The catalog**: RLS on every synced table, the policies on them, `anon` reach, role bypasses, policy functions it cannot read, views, the PowerSync publication, and policies or stream queries that read `user_metadata`, which users can set on themselves.
- **The differential**: plain signed-up users (no tenants or roles), generated rows for the synced tables and every table they or their policies reference, a device per user, and RLS reads with the same tokens. Values come from the literals the policies and stream queries compare, and columns they compare to the user's id get the run's users. Every synced row must be one RLS returns.
- **The write path**: each user inserts copies of other users' rows through RLS. An insert RLS allows that its writer cannot read back fails the run: that is a row a user can plant in data someone else syncs.

The mutation test needs a policy to mutate, so audit mode does not run it.

| Option | Default | |
| --- | --- | --- |
| `--sync-config <file>` | `sync-config.yaml` | The PowerSync sync config. |
| `--project <dir>` | `.` | The directory holding `supabase/`. |
| `--publication <name>` | `powersync` | The publication PowerSync replicates. |
| `--powersync <url>` | `http://127.0.0.1:8080` | Check the port. |
| `--compose <file>` | | Checks the PowerSync version floor. |
| `--static`, `--runs`, `--seed`, `--time-limit` | | As above. |

Audit mode reads both forms of sync config: Edition 3 sync streams (`streams:`) and the earlier sync rules (`bucket_definitions:`). A bucket definition's parameter queries are read like a stream's CTEs and its data queries like stream queries. A stream or definition that reads client parameters (`request.parameters()`, `subscription.parameter()`, `connection.parameter()`) gets a warning: those values come from the client, so a device can ask for anything, and the run does not try what it could ask for. Streams that are not `auto_subscribe` are skipped with a warning, since no device here subscribes to them.

[examples/audit-todolist](../examples/audit-todolist) runs audit mode on PowerSync's own Supabase to-do list demo: it passes as published, and `verify:planted` shows it failing once the lists query loses its owner filter. `verify:rules` does the same with the demo's rules written as sync rules.

## In CI

The verifier is built to run in CI next to the stack. Fieldbook's job ([ci.yml](../.github/workflows/ci.yml)) starts Supabase and PowerSync, applies the migrations, and runs the full verifier with the mutation test under a five-minute limit:

```yaml
- run: npx supabase start
- run: docker compose up -d --wait
- run: timeout 300 npx samesight-verify --mutate --runs 4
```

## Using the checks in your own tests

The offline checks are exported for use in a test runner:

```ts
import { checkStreams, failed, formatFindings, parseStreams } from "@samesight/verify";
import { buildIR, loadPolicy } from "samesight/compiler";
```

These are not a stable API before 1.0.
