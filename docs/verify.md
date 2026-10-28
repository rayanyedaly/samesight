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

A failure is shrunk to the smallest dataset that still shows it and described as a bug report per row: what happened (`leak`, `hidden`, `gap`, `unsent` or `differs`), which user, which table and row (with the tenant and the users and values it holds), and which stream sent it: the streams whose buckets the device received it in. A stream with one query for the row's table sent it with that query; when a stream has several, each is run in Postgres as that user (read only, rolled back) to find the ones that return the row, and the block shows their label and SQL. A stream none of whose queries could be run, or returned the row, is shown by name alone. For a leak it names the RLS policies that refuse the row, and for a gap those that let the user read it: each permissive read policy is read alone, and each restrictive one dropped alone, in a transaction that is rolled back, as the Coverage section measures them (so not when an event trigger would run on `DROP POLICY`; the block then says why). In one narrow case, with sync streams only (not sync rules), it suggests a fix: a single stream query sent the leaked row, a single permissive policy refused it, that policy is nothing but `column = auth.uid()`, and the query (with no join, OR, subquery or CTE) has no such filter. No other stream may have the same query: the two share a bucket, and fixing one would leave the other sending the row. The block then gives the `WHERE` or `AND column = auth.user_id()` to add, once the amended query, run as that user, no longer returns the row. Anything wider gets no suggestion. `--seed` replays a run exactly, and the blocks end with a `replay` line that does: `samesight-verify` (with `audit` in audit mode) and the run's own flags, less `--seed`, `--json` and `--report`, then `--seed` with the seed that failed, quoted for a POSIX shell. Run it from the same directory, since paths in it are relative to where the run started.

The run's users and rows (uuid keys starting `5a3e5a3e`) are removed when it ends. Ctrl+C, SIGTERM, SIGHUP (Ctrl+Break on Windows) or its output closing removes them too, then exits 130, 143, 129 (149) or 141; Ctrl+C again a second or more later, or a clean-up still running two minutes after the signal, exits at once and leaves them for the next verify run, which removes them first.

### 4. The write path

Forged upload batches go through `public.apply_batch` as each user, the way a modified client would send them, each in a transaction that is rolled back: rows claiming another tenant, writes to another tenant's rows, edits and deletes of append-only rows, changes to columns clients may not change, forged authors and server-owned columns, replayed inserts, read-only and unknown tables (including a user promoting their own membership), writes from a user with no membership, and inserts, updates and deletes in a user's own tenant that their role has no rule for. Every forgery must be refused or rewritten. A legitimate insert, replay and update must also go through for each writable table, so a write path that refuses everything fails too.

### 5. The mutation test (`--mutate`)

A passing differential only means something if it would have failed on a broken policy. The mutation test breaks the access layer one rule at a time and requires the differential to notice each break:

- **Sync mutants** drop a stream query's or CTE's tenant gate, role gate or row filter, or project every column where some are hidden. They are loaded together into one sync config and one PowerSync restart.
- **RLS mutants** drop a read policy's tenant gate, widen a role's rule to every row, or remove the rule, inside a rolled-back transaction.

Mutants that provably change nothing (for example, dropping a tenant gate that a composite foreign key already implies) are listed as equivalent, with the reason. Your sync config is restored on every exit path; if PowerSync cannot be restarted on the restored file, the run fails and says where the copy is. On Ctrl+C, SIGTERM or SIGHUP the original goes back first and PowerSync is restarted on it without waiting for it to replicate, so the run's users and rows can still be removed within the clean-up's two minutes; if that restart fails, or Ctrl+C again or the two minutes cut it short, the run says where the copy is and the command to load it, since PowerSync serves the mutant streams until it restarts.

Pass `--restart` if PowerSync is not restarted with `docker compose restart powersync` from the project directory.

## Options

| Option | Default | |
| --- | --- | --- |
| `--policy <file>` | `samesight.policy.ts`, else `.mts` | Paths in the policy are relative to it. |
| `--powersync <url>` | `http://127.0.0.1:8080` | The local PowerSync service. |
| `--compose <file>` | `docker-compose.yml` | For the version floor. |
| `--static` | | Static and catalog checks only. |
| `--runs <n>` | 8 | Datasets for the differential. |
| `--seed <n>` | random | Replay a run: a whole number from 0 to 2147483644. |
| `--time-limit <s>` | 120 | Stop generating datasets after this long. |
| `--mutate` | | Run the mutation test. |
| `--mutate-datasets <n>` | 8 | Datasets to try on each mutant before calling it missed. |
| `--restart <command>` | `docker compose restart powersync` | How to restart PowerSync. |
| `--json` | | Write one JSON report to stdout, and the text to stderr; see [JSON report](#json-report). |
| `--report <file>` | | Also write the findings to this file as Markdown, relative to the current directory. |

`--report` writes a file meant to be pasted into an issue: a title with the result and mode, each section's findings, and for each row a finding is about a heading with what happened, a table (the user, the row, the stream and query that sent it, the policies that refused or allowed it, the likely fix), the query's SQL in a `sql` block and the replay command. It is written on exits 0, 1 and 2 (with the error that stopped the run, a bad flag included, unless a flag comes right after `--report`, which parseArgs refuses with no file named), not when a signal stops the run; a report it cannot write turns a pass into exit 2. The file, the JSON report and the replay line carry the run's own flags and paths (an absolute `--project`, a `--powersync` URL with any credentials in it) and error messages naming local files: read it before posting it anywhere public.

The exit code is 0 when nothing failed, 1 when a check found something, and 2 when the run could not do its job: a flag it cannot read, a file it cannot find, a database or service it cannot reach, or a differential whose service broke down before it finished (a run that both found something and broke down exits 1). It is 141 when its output closed before the end (`| head`); a run whose output has gone still runs to its end (an audit whose own PowerSync is up stops there instead, and cleans up), then exits 141. Warnings do not fail a run. The summary line says `PASSED`, `FAILED: n failing`, or `INCOMPLETE: n could not run`.

**Colour.** In a terminal, `FAIL`, `warn` and `ok` are red, yellow and green with a symbol before each, and the labels of a row block are dim. Output is plain when piped or redirected, when `CI` is set, under `TERM=dumb`, and under `NO_COLOR` (any non-empty value), which wins over everything. `FORCE_COLOR` (non-empty, not `0` or `false`) turns colour on even when piped or in CI; `FORCE_COLOR=0` turns it off. Scripts that grep the output should set `NO_COLOR=1`.

## Audit mode

`samesight-verify audit` runs the same differential on a project that has no Samesight policy: its own RLS (whatever `pg_policies` says) against its own sync config. It is the quickest way to find out whether an existing Supabase and PowerSync app leaks, and it needs only the project's local Supabase stack, Docker, and the Supabase CLI in the project or on your PATH:

```bash
npm install -D @samesight/verify supabase
npx supabase start
npx samesight-verify audit --sync-config powersync/sync-config.yaml
```

You do not need to run PowerSync yourself, or have run it locally before: once the sync config and catalog checks pass, audit starts one for the run on the sync config you give it, and removes it at the end (see [what audit starts and removes](#what-audit-starts-and-removes)). To audit a PowerSync service you run yourself, pass `--powersync <url>`.

What it checks:

- **The sync config**: which tables each query sends. Query shapes it cannot map to one table are refused, never guessed at. An alias names the table on devices (`FROM documents d` sends rows of type `d`, as PowerSync does); audit maps it back, and refuses a config where one device table name would hold two tables' rows.
- **The catalog**: RLS on every synced table, the policies on them, `anon` reach, role bypasses, policy functions it cannot read, views, the PowerSync publication, and policies or stream queries that read `user_metadata`, which users can set on themselves.
- **The claims**: which token claims the policies and the sync config read, following SQL wrapper functions two levels deep (a function whose body is one claim read, or a call of another such function), and matching an overloaded function's call to the overloads its argument count can run, and what each is compared with. Run users carry what Supabase Auth gives every password user (their own id and email, `role`, `aud`, `aal1`, `app_metadata.provider`), plus the `app_metadata` and `user_metadata` values the rules compare: for a claim compared with literals, every literal (typed as the rules type it, so `3` and `'3'` are both tried), one value none of them match, and a user without it; for a claim compared only with columns (an org id), two values of the claim's cast or, without one, the first column's type (fresh run uuids, two numbers, `true` and `false`, two short strings, or the first two of a CHECK or enum list). Generated rows hold those values in the columns the claim is compared with, where the column stores them exactly (its type, integer range, `numeric(p,s)`, length, CHECK or enum list, and a CHECK pattern JavaScript can run; a CHECK range is not read, and a value it refuses only costs that row): a uuid primary key's first rows take the fresh run uuids among them as keys (for a foreign key, the referenced table's), so cleanup finds those rows; a key of another type gets none, named on the Claims line; any other column draws them often. A claim compared only with columns none of which can hold its values is not given to users at all. Columns are matched by bare name in the tables of the rules that compare them (a joined column by its table); a column no rule names a table for (only subqueries or CTEs compare it) is matched in every generated table with the name, primary keys aside. A claim compared only with keys to `auth.users` gets the ids of two run users (u0 and u1), which generated rows already point such columns at (compared with other columns too, it takes fresh values, and the user columns are named as getting none); run users are created with ids minted up front that carry the run's prefix, so a row keyed by its user's id counts as the run's own. A column of another type or part of a composite foreign key gets none; the Claims line names each. Users take every combination of these values when there are at most six; beyond that, at most eight users are signed up, every value is held while there are at most six per claim, and the section names what no user holds. Where every read of a claim casts it to a number, values are compared as numbers (`'01'`, `1` and `1.0` are one value; a literal a double cannot hold exactly, or text an integer cast refuses, stays as written); read as text, they stay apart, and go into a number column only in the form Postgres prints back (`100`, not `1e2` or `0100`; `1.50` in a `numeric(5,2)`). Two users share the same claims, so a role also sees rows of someone else with it. Each user is labelled by what its token carries, `u1 (app_metadata.role=editor)`, and the section lists who holds each value. Every other claim a rule reads is listed with why it is not tested: one Auth gives every user alike or none at all (`client_id`, which Auth sets only on tokens an OAuth client gets, and `jti` and `nbf`; with an access token hook enabled, these top-level ones count as the hook's), metadata compared only with columns no generated row can hold its values in, or used in a way audit cannot give a value for, one only an access token hook adds that audit cannot give rows to (below), a read of the whole token or a whole object, or a read audit cannot follow (a function that reads the token three levels down, or through an overload audit cannot tell from another, included), which is reported rather than guessed at. Uuid columns compared with the user id in any spelling (`auth.uid()`, `auth.jwt() ->> 'sub'`, `token_parameters.user_id`) get the run's users, matched by bare column name in every table, except primary keys and foreign keys to other tables.
- **The access token hook**: when `supabase/config.toml` enables a `pg-functions://` hook, audit reads its function and the public tables its body reads (after FROM, JOIN and USING, through `pg_depend` for a SQL-standard body, and in the project functions it calls, two levels deep). Each such table with a column pointing at `auth.users` (a memberships table) gets a row for run users before anyone signs in (every user but the last, or, for a table with nothing to vary, some users a row and some none), so the hook adds claims that differ between users; the rows vary over the rows their keys point at (each table they point at gets two rows), their CHECK or enum list, and the literals rules compare a column with when the hook names it, picked jointly with the metadata values above. These rows stay for the whole run (generated rows never go into those tables) and are removed with the run's users. Generated rows hold the values the hook can add in the columns the rules compare its claims with (the rules' literals, the options of the hook's rows, and one value none of them match), as for metadata; keys, user columns and the hook's own per-user tables are left alone, and a table the per-user rows point at takes them only when two values at least fit it. The Claims section says what the run gives the hook and who holds each claim it adds, and warns when no token carries a value the rules compare with, or every token carries the same one although the rows differ. It also warns when the role the hook runs as (`supabase_auth_admin`, or the owner of a SECURITY DEFINER hook) may not read a table it reads (no USAGE on `public`, no SELECT grant, or RLS with no policy for it), when the hook builds SQL at run time, writes to a table, calls out (`pg_notify`, `net`, `http`, `dblink`), sets `app_metadata` or `user_metadata` in the token, or reads a view; when `anon` or `authenticated` can execute the hook (Postgres and Supabase grant new functions to them by default; the warning gives the SQL Supabase's guide runs: usage on the hook's schema and execute on it for `supabase_auth_admin`, then the revoke, from any role they are members of that holds execute too; `supabase_auth_admin` keeps its own grant), since with its schema exposed through the API they can run it for any user id; and when it calls, three or more calls deep, a function with a body of its own, which audit does not read. A function it calls reads every column of the tables a select of it takes whole rows from, up to its statement's end or a loop's body: a select whose list has `*` or `t.*` (after `distinct` too), or `to_jsonb`, `to_json`, `row_to_json` or `hstore` of a table it reads or that table's alias. Other forms (`jsonb_agg(t)`, `to_jsonb(t.*)`, a bare `select t into r`) are not recognised, and a select under `exists (...)` reads none. The hook's own `select *` reads every column of every table it reads. A hook audit cannot give rows to (an HTTP hook, a missing function, no public table read, a table it could not fill or find again) is named with the reason, and its claims are tested only for the values tokens carry. A table the hook reads with no column for a user is only noted. A `pg-functions://` hook is printed in full; an HTTP hook as its scheme and host (and port), followed by `/...` when it has a path; any other URI as its scheme alone.
- **The differential**: the run's signed-up users (no tenants; the metadata above), generated rows for the synced tables and every table they or their policies reference, a device per user, and RLS reads with the same tokens. Values come from the literals the policies and stream queries compare, and columns they compare to the user's id get the run's users. Every synced row must be one RLS returns.
- **Coverage**: over the datasets run before any failure, whether each RLS read policy on a synced table, and each stream per table it sends, was seen both letting a run user have a generated row and keeping one from them; a rule seen only one way passed without being tested. A permissive policy is measured alone: every other policy on its table is dropped inside a transaction that is always rolled back, so nothing is committed. It allowed a row when it returns it alone, and refused one when neither it nor the table's full RLS returns it. A restrictive policy refused a row the full RLS keeps out but returns without it, and allowed one the full RLS returns. A stream sent a row when the user's device received it from that stream, and withheld one it did not; streams whose queries differ only in comparing `auth.parameter()` with literals share one PowerSync bucket, so they are measured together. Counts are over (run user, generated row) pairs; rows the run keeps for the access token hook count too, in a synced table, and a claim the hook adds counts as held when run users' tokens carry two or more values of it (none counting as one). Each rule seen one way is named with the side seen and, where the run can tell, why: no row of its table was inserted, it reads a claim no run user holds, the values it needs were not held together, or another policy let through every row it refused. A rule that reads nothing of the user is fine seen one way. The differential runs more datasets, within `--time-limit`, while a rule run users could exercise has not been seen both ways; they are new random datasets, not aimed at the rule. Coverage is per policy and per stream: the branches of an OR and the queries of one stream are not told apart. Policies are not measured when an event trigger would run on `DROP POLICY` (they are named; PostgREST's own, which only send a notification a rolled-back transaction never sends, do not count), and write policies are not measured at all.
- **The write path**: each user inserts copies of other users' rows through RLS (the rows kept for the access token hook included). An insert RLS allows that its writer cannot read back fails the run: that is a row a user can plant in data someone else syncs.

The mutation test needs a policy to mutate, so audit mode does not run it.

| Option | Default | |
| --- | --- | --- |
| `--sync-config <file>` | `sync-config.yaml` | The PowerSync sync config. |
| `--project <dir>` | `.` | The directory holding `supabase/`. |
| `--powersync <url>` | | Audit a PowerSync service you run yourself, instead of starting one. |
| `--keep-powersync` | | Leave the service audit started up; see [keeping the service](#keeping-the-service). |
| `--publication <name>` | `powersync` | With `--powersync` or `--static`: the publication to check. The service audit starts always replicates `powersync`. |
| `--compose <file>` | | With `--powersync` or `--static`: checks the version floor of the PowerSync service that compose file runs. |
| `--static`, `--runs`, `--seed`, `--time-limit`, `--json`, `--report` | | As above. `--static` starts no PowerSync. |

Audit mode reads both forms of sync config: Edition 3 sync streams (`streams:`) and the earlier sync rules (`bucket_definitions:`). A bucket definition's parameter queries are read like a stream's CTEs and its data queries like stream queries. A stream or definition that reads client parameters (`request.parameters()`, `subscription.parameter()`, `connection.parameter()`) gets a warning: those values come from the client, so a device can ask for anything, and the run does not try what it could ask for. Streams that are not `auto_subscribe` are skipped with a warning, since no device here subscribes to them.

### What audit starts and removes

Without `--powersync`, once the sync config and catalog checks pass (so the project has a `powersync` publication that lists every synced table), audit finds the project's running Supabase containers by the labels the Supabase CLI puts on them, takes a lock on the database so no other audit starts PowerSync on it meanwhile, reuses a service an earlier run kept (see below) or removes what a killed run left, pulls the images it needs, and, for this run only:

1. creates a login role `samesight_audit_<run>` with `REPLICATION` and `BYPASSRLS` (PowerSync's first snapshot reads the tables under RLS) and `SELECT` on the tables the sync config reads. `REPLICATION` also lets it stream every change written to the database through the project's publication, so its password is random, never shown, and sent to Postgres only as a SCRAM verifier;
2. starts a throwaway Postgres container for PowerSync's storage, on a tmpfs, so it leaves no volume;
3. starts the PowerSync service ([`journeyapps/powersync-service`](https://hub.docker.com/r/journeyapps/powersync-service) 1.27.2, pinned by digest) on the Supabase network, its port published on 127.0.0.1 only. Tokens are checked against the project's JWKS when Auth has a signing key, or with its shared HS256 secret otherwise. Its replication slots are named `samesight_audit_<run>_...`, so nothing of a PowerSync you run yourself is touched. The project's publication is only read, never changed.

When the run ends, by passing, failing, an error, Ctrl+C, SIGTERM, the terminal closing or its output closing (`| head`, quitting `less`), it removes both containers, the replication slots and the role; anything it cannot remove it names (unless its output has gone), and the next audit that starts PowerSync removes it. A run stopped by a signal or a closed output exits 130 (Ctrl+C), 143 (SIGTERM), 129 (SIGHUP) or 141 (output closed) once it has cleaned up. During the clean-up, a different signal does not cut it short, but the same one again a second or more later (Ctrl+C again, a second SIGTERM) does, as does a clean-up still running two minutes after a signal; what is left of the service, the next audit that starts PowerSync removes, and the run's users and rows the next audit that reaches the differential. `nohup` does not keep a run going when its terminal closes (the run ends and cleans up); use `tmux` or `screen`, or `setsid` with the output sent to a file (`setsid npx samesight-verify audit > audit.log 2>&1`). If the run broke down (an error, or a differential that could not finish its datasets), it prints the service's last log lines. A service that stops before it replicates (as one that refuses its sync config does) fails the start with its last log lines, and a device that has failed to reach the service and stayed unconnected for 10 seconds gives up rather than waiting out the minute. A run killed outright (SIGKILL, a crash, a reboot) cannot clean up: its containers, role and replication slot (which holds the database's write-ahead log) stay until the next audit of the project that starts PowerSync removes them before it starts. To remove them by hand (a service kept with `--keep-powersync` too), while no audit of the project is running, with the project's `project_id` from `supabase/config.toml`:

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

The run's users (`@verify.samesight.test`) and its rows (uuid keys starting `5a3e5a3e`) are removed when the run ends by passing, failing or an error. On Ctrl+C, SIGTERM or SIGHUP (or its output closing) it removes them; a run killed outright, stopped again before its clean-up ends (Ctrl+C again), or whose clean-up is blocked or finds another run already holding the database leaves them for the next audit that reaches the differential, which removes them first. Until then, some of those users can hold privileged `app_metadata` such as `role: admin`, with a random password nobody is shown. To remove them by hand, with no verify run going: `delete from auth.users where email like '%@verify.samesight.test'` (delete the run's rows first if a foreign key without `on delete cascade` points at those users). Cleanup also looks beyond the run's tables, in the public tables with a column pointing at `auth.users` and those they reach (an earlier run's rows for an access token hook since turned off, say), as the project's own deletes would: one table at a time, with its foreign keys, cascades and triggers, for rows keyed by the run's prefix or whose required columns pointing at `auth.users` all hold run users. A table that refuses keeps its rows. There, and in a table without a single key, a row whose only link to a run user is an optional column (`invited_by`) is not the run's, and is kept even when it then blocks deleting that user, as is a row whose required owners are a run user and someone else. The run then names the tables whose rows still reference which users; those rows may hold a real user's data, so remove or repoint them by hand before deleting the users, which no later run does until then. Where such a row's foreign key cascades, deleting the user removes the row with it, someone else's data included.

Passwords and the service config travel to the containers through Docker's environment, never on a command line; like any container's environment, they are visible to `docker inspect` while the containers exist. The errors from starting PowerSync, the service's log lines and auto-start's own log lines have the run's passwords and the JWT secret masked.

#### Keeping the service

With `--keep-powersync`, the run leaves the service up: both containers, the role and its replication slot. The next audit of the project reuses it when the sync config, tables and token check are the same and its role and slot are still in the database, with the role still able to read those tables, which saves the start-up; otherwise it removes it and starts afresh. The next audit that starts PowerSync without the flag removes it when it ends, so run one when you are done (an audit with `--static` or `--powersync`, or one stopped by the checks before the differential, leaves it): while the service is kept, its replication slot holds the database's write-ahead log.

The PowerSync service is source-available under the [FSL-1.1-ALv2](https://github.com/powersync-ja/powersync-service/blob/main/LICENSE) license. Audit pulls the official image from Docker Hub the first time (it says so), with `postgres:18.6` for its storage, and runs them on your machine; Samesight never bundles or redistributes them.

[examples/audit-todolist](../examples/audit-todolist) runs audit mode on PowerSync's own Supabase to-do list demo: it passes as published, and `verify:planted` shows it failing once the lists query loses its owner filter. `verify:rules` does the same with the demo's rules written as sync rules. [examples/audit-roles](../examples/audit-roles) is an app whose RLS and streams read a role and an org from `app_metadata`; its `verify:planted` shows audit catching a leak only users holding the editor role see.

## JSON report

With `--json`, in either mode, stdout carries exactly one JSON document and everything else the run prints (sections, progress, the summary line) goes to stderr. The document is written on exits 0, 1 and 2, a flag it cannot read or a file it cannot find included; a run stopped by a signal or a closed output writes none. It follows [`schema/report.schema.json`](../packages/verify/schema/report.schema.json) (JSON Schema draft 2020-12), which the package ships and exports as `@samesight/verify/schema/report.schema.json`. The schema allows no fields it does not list, so validate a document against the schema its own `$schema` names, the one of the version that wrote it:

```json
{
  "$schema": "https://unpkg.com/@samesight/verify@0.1.0/schema/report.schema.json",
  "version": 1,
  "tool": "samesight-verify",
  "toolVersion": "0.1.0",
  "mode": "audit",
  "result": "failed",
  "exitCode": 1,
  "durationMs": 48210,
  "sections": [{ "title": "Differential (4 users, 1 datasets)", "findings": [{ "status": "fail", "check": "differential", "detail": "devices and RLS disagree (seed 1842, ...)" }] }]
}
```

`result` is `passed`, `failed` or `incomplete`, as the exit code is 0, 1 or 2. Each section holds its findings as the text prints them (`status`, `check`, `detail`, and `incomplete` on one that could not run); a differential finding adds `rows`, one bug report per row with the user, the row, the streams and queries that sent it, the policies and the likely fix the text shows. `seed` is the `--seed` the run was given (a run without one picks its own, which only the `replay` command and the finding's text carry), `replay` the command that replays a failure, and `error` the message of an error that stopped the run (a bad flag, a missing file, a database it could not reach). `version` goes up only when a change would break a reader.

## In CI

The verifier is built to run in CI next to the stack. Fieldbook's job ([ci.yml](../.github/workflows/ci.yml)) starts Supabase and PowerSync, applies the migrations, and runs the full verifier with the mutation test under a five-minute limit:

```yaml
- run: npx supabase start
- run: docker compose up -d --wait
- run: timeout 300 npx samesight-verify --mutate --runs 4
```

To keep the findings as data, add `--json > verify.json` and upload the file as an artifact; the log still shows the text, and the exit code still fails the step.

For audit mode on GitHub, the [GitHub Action](ci.md) starts the Supabase services audit needs, runs the audit, adds the Markdown report to the job summary and stops Supabase.

## Using the checks in your own tests

The offline checks are exported for use in a test runner:

```ts
import { checkStreams, failed, formatFindings, parseStreams } from "@samesight/verify";
import { buildIR, loadPolicy } from "samesight/compiler";
```

These are not a stable API before 1.0.
