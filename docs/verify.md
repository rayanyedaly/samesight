# The verifier

`samesight-verify` answers one question: can any device receive a row that Postgres RLS would refuse to show its user? It answers it by running your real stack, not by reading SQL.

```bash
npx samesight-verify            # static, catalog, differential, write path
npx samesight-verify --mutate   # and the mutation test
npx samesight-verify audit ...  # a project with hand-written RLS and sync streams
```

It needs the project's local stack running: Supabase (`supabase start`) and the PowerSync service (audit mode can start its own, with Docker). It creates users, writes and deletes rows, with `--mutate` restarts PowerSync, and in audit mode starts containers and a replication role of its own, so it refuses to run against anything that is not this machine. Every database and HTTP address must be `localhost`, `127.0.0.1` or `::1`, `NODE_ENV` must be `development` or `test`, and variables a hosting platform sets (`VERCEL`, `FLY_APP_NAME`, `KUBERNETES_SERVICE_HOST` and others) must be absent. A port forwarded to a remote database looks local, so never run it through one. Audit mode also checks that the Supabase database container it finds in Docker is the database it connects to (the same port, the same system identifier), so it never starts PowerSync on another machine's Docker.

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

For every role in two tenants, plus a second user of one role and a user with no membership, it signs up a real Supabase user, and adds a third tenant whose rows nobody in the run may see. [fast-check](https://fast-check.dev) generates datasets across the policy's tables from the schema: foreign keys pick existing parents within the tenant, user columns pick the run's users, and values come from check-constraint lists, enum labels and the literals your rules compare, so most rules get rows on both sides of them (audit mode's Coverage section names each rule that did not; it does not tell the branches of an OR apart). Columns with a default are sometimes left to it, so a rule that depends on the default is tested too. For each dataset, every user gets a headless `@powersync/node` device that syncs through your PowerSync service, and the verifier reads the same tables through RLS with the same token claims. Then:

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

The exit code is 0 when nothing failed, 1 otherwise, and 141 when its output closed before the end (`| head`); a run whose output has gone still runs to its end (an audit whose own PowerSync is up stops there instead, and cleans up), then exits 141. Warnings do not fail a run.

## Audit mode

`samesight-verify audit` runs the same differential on a project that has no Samesight policy: its own RLS (whatever `pg_policies` says) against its own sync config. It is the quickest way to find out whether an existing Supabase and PowerSync app leaks, and it needs only the project's local Supabase stack and Docker:

```bash
npx supabase start
npx @samesight/verify audit --sync-config powersync/sync-config.yaml
```

You do not need to run PowerSync yourself, or have run it locally before: once the sync config and catalog checks pass, audit starts one for the run on the sync config you give it, and removes it at the end (see [what audit starts and removes](#what-audit-starts-and-removes)). To audit a PowerSync service you run yourself, pass `--powersync <url>`.

What it checks:

- **The sync config**: which tables each query sends. Query shapes it cannot map to one table are refused, never guessed at.
- **The catalog**: RLS on every synced table, the policies on them, `anon` reach, role bypasses, policy functions it cannot read, views, the PowerSync publication, and policies or stream queries that read `user_metadata`, which users can set on themselves.
- **The claims**: which token claims the policies and the sync config read, following SQL wrapper functions one level, and what each is compared with. Run users carry what Supabase Auth gives every password user (their own id and email, `role`, `aud`, `aal1`, `app_metadata.provider`), plus the `app_metadata` and `user_metadata` values the rules compare: for a claim compared with literals, every literal (typed as the rules type it, so `3` and `'3'` are both tried), one value none of them match, and a user without it; for a claim compared only with columns (an org id), two values of the first column's type (fresh run uuids, two numbers, `true` and `false`, two short strings, or the first two of its CHECK or enum list). Generated rows hold those values in the columns the claim is compared with, where the column's type, length and CHECK or enum list take them: a primary key's first rows take them as keys (for a foreign key, the referenced table's), any other column draws them often. Columns are matched by bare name in the tables of the rules that compare them (a joined column by its table); when a rule's table is unknown (a subquery, a CTE), every generated table with the name, primary keys aside. A key to `auth.users`, a column of another type, part of a composite foreign key, or one whose CHECK range a value breaks, gets none; the Claims line names those it can tell. Users take every combination of these values when there are at most six; beyond that, at most eight users are signed up, every value is held while there are at most six per claim, and the section names what no user holds. Two users share the same claims, so a role also sees rows of someone else with it. Each user is labelled by what its token carries, `u1 (app_metadata.role=editor)`, and the section lists who holds each value. Every other claim a rule reads is listed with why it is not tested: one Auth gives every user alike, metadata compared only with columns no generated row can hold its values in, or used in a way audit cannot give a value for, one only an access token hook adds, a read of the whole token or a whole object, or a read audit cannot follow (a function that reads the token two levels down included), which is reported rather than guessed at. Uuid columns compared with the user id in any spelling (`auth.uid()`, `auth.jwt() ->> 'sub'`, `token_parameters.user_id`) get the run's users, matched by bare column name in every table, except primary keys and foreign keys to other tables.
- **The differential**: the run's signed-up users (no tenants; the metadata above), generated rows for the synced tables and every table they or their policies reference, a device per user, and RLS reads with the same tokens. Values come from the literals the policies and stream queries compare, and columns they compare to the user's id get the run's users. Every synced row must be one RLS returns.
- **Coverage**: over the datasets run before any failure, whether each RLS read policy on a synced table, and each stream per table it sends, was seen both letting a run user have a generated row and keeping one from them; a rule seen only one way passed without being tested. A permissive policy is measured alone: every other policy on its table is dropped inside a transaction that is always rolled back, so nothing is committed. It allowed a row when it returns it alone, and refused one when neither it nor the table's full RLS returns it. A restrictive policy refused a row the full RLS keeps out but returns without it, and allowed one the full RLS returns. A stream sent a row when the user's device received it from that stream, and withheld one it did not; streams whose queries differ only in comparing `auth.parameter()` with literals share one PowerSync bucket, so they are measured together. Counts are over (run user, generated row) pairs. Each rule seen one way is named with the side seen and, where the run can tell, why: no row of its table was inserted, it reads a claim no run user holds, the values it needs were not held together, or another policy let through every row it refused. A rule that reads nothing of the user is fine seen one way. The differential runs more datasets, within `--time-limit`, while a rule run users could exercise has not been seen both ways; they are new random datasets, not aimed at the rule. Coverage is per policy and per stream: the branches of an OR and the queries of one stream are not told apart. Policies are not measured when an event trigger would run on `DROP POLICY` (they are named; PostgREST's own, which only send a notification a rolled-back transaction never sends, do not count), and write policies are not measured at all.
- **The write path**: each user inserts copies of other users' rows through RLS. An insert RLS allows that its writer cannot read back fails the run: that is a row a user can plant in data someone else syncs.

The mutation test needs a policy to mutate, so audit mode does not run it.

| Option | Default | |
| --- | --- | --- |
| `--sync-config <file>` | `sync-config.yaml` | The PowerSync sync config. |
| `--project <dir>` | `.` | The directory holding `supabase/`. |
| `--powersync <url>` | | Audit a PowerSync service you run yourself, instead of starting one. |
| `--keep-powersync` | | Leave the service audit started up; see [keeping the service](#keeping-the-service). |
| `--publication <name>` | `powersync` | With `--powersync` or `--static`: the publication to check. The service audit starts always replicates `powersync`. |
| `--compose <file>` | | With `--powersync` or `--static`: checks the version floor of the PowerSync service that compose file runs. |
| `--static`, `--runs`, `--seed`, `--time-limit` | | As above. `--static` starts no PowerSync. |

Audit mode reads both forms of sync config: Edition 3 sync streams (`streams:`) and the earlier sync rules (`bucket_definitions:`). A bucket definition's parameter queries are read like a stream's CTEs and its data queries like stream queries. A stream or definition that reads client parameters (`request.parameters()`, `subscription.parameter()`, `connection.parameter()`) gets a warning: those values come from the client, so a device can ask for anything, and the run does not try what it could ask for. Streams that are not `auto_subscribe` are skipped with a warning, since no device here subscribes to them.

### What audit starts and removes

Without `--powersync`, once the sync config and catalog checks pass (so the project has a `powersync` publication that lists every synced table), audit finds the project's running Supabase containers by the labels the Supabase CLI puts on them, takes a lock on the database so no other audit starts PowerSync on it meanwhile, reuses a service an earlier run kept (see below) or removes what a killed run left, pulls the images it needs, and, for this run only:

1. creates a login role `samesight_audit_<run>` with `REPLICATION` and `BYPASSRLS` (PowerSync's first snapshot reads the tables under RLS) and `SELECT` on the tables the sync config reads. `REPLICATION` also lets it stream every change written to the database through the project's publication, so its password is random, never shown, and sent to Postgres only as a SCRAM verifier;
2. starts a throwaway Postgres container for PowerSync's storage, on a tmpfs, so it leaves no volume;
3. starts the PowerSync service ([`journeyapps/powersync-service`](https://hub.docker.com/r/journeyapps/powersync-service) 1.27.2, pinned by digest) on the Supabase network, its port published on 127.0.0.1 only. Tokens are checked against the project's JWKS when Auth has a signing key, or with its shared HS256 secret otherwise. Its replication slots are named `samesight_audit_<run>_...`, so nothing of a PowerSync you run yourself is touched. The project's publication is only read, never changed.

When the run ends, by passing, failing, an error, Ctrl+C, SIGTERM, the terminal closing or, while its PowerSync is up, its output closing (`| head`, quitting `less`), it removes both containers, the replication slots and the role; anything it cannot remove it names (unless its output has gone), and the next audit that starts PowerSync removes it. A run stopped by a signal or a closed output exits 130 (Ctrl+C), 143 (SIGTERM), 129 (SIGHUP) or 141 (output closed) once it has cleaned up. During the clean-up, a different signal does not cut it short, but the same one again a second or more later (Ctrl+C again, a second SIGTERM) does, as does a clean-up still running two minutes after a signal; what is left, the next audit that starts PowerSync removes. `nohup` does not keep a run going when its terminal closes (the run ends and cleans up); use `tmux` or `screen`, or `setsid` with the output sent to a file (`setsid npx samesight-verify audit > audit.log 2>&1`). If the run broke down with an error, it prints the service's last log lines. A run killed outright (SIGKILL, a crash, a reboot) cannot clean up: its containers, role and replication slot (which holds the database's write-ahead log) stay until the next audit of the project that starts PowerSync removes them before it starts. To remove them by hand (a service kept with `--keep-powersync` too), while no audit of the project is running, with the project's `project_id` from `supabase/config.toml`:

```bash
project=my-project
docker ps --all --quiet --filter "label=dev.samesight.audit.project=$project" | xargs -r docker rm --force --volumes
docker exec -i "supabase_db_$project" psql -v ON_ERROR_STOP=1 -U postgres <<'SQL'
select pg_terminate_backend(active_pid, 5000) from pg_replication_slots where active and starts_with(slot_name, 'samesight_audit_');
select pg_drop_replication_slot(slot_name) from pg_replication_slots where not active and starts_with(slot_name, 'samesight_audit_');
do $$ declare r text; begin
  for r in select rolname from pg_roles where starts_with(rolname, 'samesight_audit_') loop
    execute format('revoke all on all tables in schema public from %I', r);
    execute format('revoke all on schema public from %I', r);
    execute format('drop role %I', r);
  end loop;
end $$;
SQL
```

The run's users (`@verify.samesight.test`) and its rows (uuid keys starting `5a3e5a3e`) are removed when it ends, and by the next run if it was killed. Until then, some of those users can hold privileged `app_metadata` such as `role: admin`, with a random password nobody is shown. To remove them by hand, with no audit running: `delete from auth.users where email like '%@verify.samesight.test'` (delete the run's rows first if a foreign key without `on delete cascade` points at those users).

Passwords and the service config travel to the containers through Docker's environment, never on a command line; like any container's environment, they are visible to `docker inspect` while the containers exist. The errors from starting PowerSync, the service's log lines and auto-start's own log lines have the run's passwords and the JWT secret masked.

#### Keeping the service

With `--keep-powersync`, the run leaves the service up: both containers, the role and its replication slot. The next audit of the project reuses it when the sync config, tables and token check are the same and its role and slot are still in the database, with the role still able to read those tables, which saves the start-up; otherwise it removes it and starts afresh. The next audit that starts PowerSync without the flag removes it when it ends, so run one when you are done (an audit with `--static` or `--powersync`, or one stopped by the checks before the differential, leaves it): while the service is kept, its replication slot holds the database's write-ahead log.

The PowerSync service is source-available under the [FSL-1.1-ALv2](https://github.com/powersync-ja/powersync-service/blob/main/LICENSE) license. Audit pulls the official image from Docker Hub the first time (it says so), with `postgres:18.6` for its storage, and runs them on your machine; Samesight never bundles or redistributes them.

[examples/audit-todolist](../examples/audit-todolist) runs audit mode on PowerSync's own Supabase to-do list demo: it passes as published, and `verify:planted` shows it failing once the lists query loses its owner filter. `verify:rules` does the same with the demo's rules written as sync rules. [examples/audit-roles](../examples/audit-roles) is an app whose RLS and streams read a role and an org from `app_metadata`; its `verify:planted` shows audit catching a leak only users holding the editor role see.

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
