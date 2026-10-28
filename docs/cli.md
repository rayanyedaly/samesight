# The CLIs

Both CLIs need Node 22.18 or newer. They find the policy file in the current directory (`samesight.policy.ts`, else `samesight.policy.mts`) unless `--policy` names one, and every path in the policy is relative to the policy file. `samesight lint` and `samesight-verify audit` need no policy file.

## `samesight`

From the `samesight` package.

| Command | Database | What it does |
| --- | --- | --- |
| `samesight init` | optional | Drafts a policy file from the local database, or writes a template without one. Refuses to overwrite an existing policy. |
| `samesight generate` | required | Reads the schema in one read-only transaction and writes every generated file. Adds a migration only when its content changes. |
| `samesight check` | no | Regenerates from the saved schema snapshot and fails if any file on disk differs. For CI. |
| `samesight doctor` | required | Checks the running database against the policy. |
| `samesight explain` | no | Prints who can read and write what, in plain words, from the saved snapshot. |
| `samesight lint [file ...]` | no | Checks PowerSync sync configs for known leak patterns, reading files only. Needs no policy. |
| `samesight audit` | required | Runs `samesight-verify audit`, which tests the rows: needs `@samesight/verify`. Needs no policy. |

Every command exits 0 when it passes, 1 when it found something (a stale file, a failing doctor check, a lint error, a policy that does not compile), and 2 when it could not run: no command or an unknown one, a flag it cannot read, a policy, snapshot or file it cannot find, an existing policy `init` would overwrite, or a database it cannot reach.

| Option | |
| --- | --- |
| `--policy <file>` | The policy file. |
| `--db <url>` | The local database. Default: `$SAMESIGHT_DB_URL`, else the `[db]` port in `supabase/config.toml` next to the policy, else the Supabase CLI's default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. |
| `--table <name>` | `explain` only: one table. |
| `--migrations <dir>` | `lint` only: the SQL migrations to read RLS from. Default: `supabase/migrations`, when it exists. |
| `--allow <rule>[:<name>]` | `lint` only: accept a rule's findings, all of them or those about one stream, bucket, table or policy. Repeatable. |
| `--format <text\|json\|sarif\|github>` | `lint` only: `json` prints one JSON object on stdout, each finding with its 1-based `line` and `column` where known; `sarif` one SARIF 2.1.0 log; `github` GitHub Actions annotations. Notes stay on stderr, and the exit code is the same in every format. |
| `-v`, `--version` | |
| `-h`, `--help` | |

The database must be on this machine. A URL whose host, query parameters or resolved address points anywhere else is refused before connecting.

### `init`

```console
$ npx samesight init
  membership: Membership (userId -> tenantId, role)
  tenant table: Tenant
  roles from Membership.role: ADMIN, INSPECTOR, VIEWER
wrote /app/samesight.policy.ts
```

It looks for a membership table (a unique uuid column named like `user_id` or `userId`, a uuid tenant column named like `tenant_id`, `org_id`, `team_id` or `workspace_id`, and a `role` column), takes the tenant table from the membership's foreign key, and reads the role values from an enum or a `CHECK (role in (...))`. If it finds `supabase gen types` output in a usual place (`supabase/types.ts`, `src/types/supabase.ts`, `database.types.ts` and a few more), the policy imports it from there.

### `generate`

Writes the migration, the sync and service config, the client schema, the policy types, the manifest and the schema snapshot. Warnings (an unindexed `via` column, for example) are printed but do not fail. After it writes a new migration, apply it (`supabase migration up`, or `supabase db reset`) and restart PowerSync so it reads the new sync config.

### `check`

Exit code 1 and a list of stale files when anything differs (2 when there is no schema snapshot to check against). It needs no database, so it runs anywhere your type check runs.

### `doctor`

```text
ok    schema: the database matches the snapshot generate saved
ok    policy: the latest generated migration matches the policy
ok    migration: 20261025203313 is applied
ok    token hook: samesight.custom_access_token_hook exists
ok    row level security: on for all 6 tables
ok    replica identity: FULL on every synced table
ok    publication: powersync publishes exactly the synced tables
ok    replication role: powersync_role is ready
ok    replication: powersync_3_00a0: active, lag 1089056 bytes
ok    auth config: the access token hook is on and calls samesight.custom_access_token_hook
```

The last line reads `supabase/config.toml`: it fails while the access token hook is off (as `supabase init` leaves it) or calls another function, and warns without an Auth signing key, which PowerSync needs to verify tokens.

### `explain`

An excerpt, on Fieldbook:

```text
R I U D: every row of the tenant   r i u d: some rows   -: none
            ADMIN      INSPECTOR  VIEWER
Site        RIUD       R---       R---
Inspection  RIUD       r-u-       r---

Inspection (tenant column tenantId)
  read:
    ADMIN: every row
    INSPECTOR: rows where assigneeId = the signed-in user
    VIEWER: rows where status is one of PUBLISHED, ARCHIVED
  update:
    ADMIN: every row
    INSPECTOR: rows where assigneeId = the signed-in user and status is one of DRAFT, IN_PROGRESS (before and after the change)
    VIEWER: nothing
  clients write: assigneeId, title, status, internalNotes
  clients set on insert only: siteId
  the server sets: createdAt, tenantId (from the token), updatedAt (now(), on every update)
  never synced to VIEWER: internalNotes (still readable over the REST API; RLS is per row)
```

Paste it in a pull request that changes the policy, so reviewers see the effect without reading SQL.

### `lint`

Reads a PowerSync sync config (sync streams or legacy sync rules) and, when present, the project's SQL migrations, and reports known leak patterns. It needs no database, no PowerSync service and no policy file, so it fits any project and any CI job. With no file named it looks for `sync-config.yaml` or `sync-rules.yaml`, in the current directory and then under `powersync/`.

```console
$ npx samesight lint
powersync/sync-rules.yaml:5  error    bucket user_info has no parameter query, so every user receives every row of trellouser  (unscoped-query)
powersync/sync-rules.yaml:5  warning  trellouser is synced, but the migrations never enable row level security on it, so unless its grants to anon and authenticated were revoked, any client can read and change every row through the Supabase API  (rls-off)
powersync/sync-rules.yaml:14  error    bucket by_workspace, parameters[2] reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists  (unscoped-query)
powersync/sync-rules.yaml:17  warning  policy "members read" on workspace (supabase/migrations/20260101000000_init.sql:12) lets every signed-in user read every row through the Supabase API, whatever the sync config sends  (rls-open)
2 errors, 2 warnings
```

That is PowerSync's Trello demo with a made-up migration. Its third parameter query reads `WHERE visibility = "Public"`. Double quotes name a column, not a string, so it reads nothing from the token and filters by no fixed value, and lint fails it; most likely it was meant to list public workspaces, which written as `'Public'` would be the "fixed filters" warning for data public by design.

Lint proves nothing about what reaches a device: it flags known mistakes in seconds. `samesight-verify audit` tests the rows. The migrations reader is best-effort: it follows plain DDL (`alter table` enabling or disabling row level security, renaming the table or moving it out of `public`, `create policy`, `alter policy`, `drop policy`, `drop table`) in file order, and does not see RLS changed inside functions, `DO` blocks or dynamic SQL. Without migrations, `rls-off` and `rls-open` do not run, and lint says so.

Warnings do not fail the run, but each one needs a decision: a warning can be a real leak (`deleted = false` filters rows yet sends every undeleted one to everyone; `auth.user_id() IN (SELECT id FROM profiles)` admits every user, not admins). Fix it, or accept it as below. A finding that is deliberate, such as a table public by design, can be accepted with `--allow unscoped-query:customers` (by stream, bucket, table or policy name) or `--allow not-auto-subscribed` (a whole rule). Allowed findings are counted in the output, never dropped silently, and a misspelt rule name is an error.

Exit codes: `0` when nothing is an error (warnings and notes do not fail a run), `1` on any error, `2` when a file cannot be read, no sync config is found or an option is wrong.

For CI, `--format sarif` prints one SARIF 2.1.0 log for GitHub code scanning (`github/codeql-action/upload-sarif`), which shows a finding on a pull request when its line is part of the change. Each result names its rule, with a link to the rule's page, its file (relative paths stay relative) and, when known, its line and column; findings `--allow` accepted are included as suppressed, and files that could not be read are reported as tool notifications. On a private repository, code scanning needs GitHub Code Security. `--format github` needs nothing: it prints one workflow command per finding (`::error file=sync-config.yaml,line=6,col=12,title=samesight unscoped-query::...`, `::warning` and `::notice` for the others), which GitHub Actions shows as annotations on the run and on the pull request's changed lines. Allowed findings are counted in one `::notice`, not printed.

The rules, each with a page of its own: an example, what lint prints on it, the fix, and what audit does with it. [Lint rules](rules/index.md) lists them with their levels.

#### `unscoped-query`

Rows every user receives, because nothing ties them to who is asking. [More](rules/unscoped-query.md)

#### `client-scoped`

Rows picked by what the client sends, with nothing tying them to who is asking. [More](rules/client-scoped.md)

#### `user-metadata`

Access decided by the token's `user_metadata`, which every user can set on themselves. [More](rules/user-metadata.md)

#### `unreadable-query`

A query `samesight-verify audit` cannot attribute to one table, so it cannot check it. [More](rules/unreadable-query.md)

#### `not-auto-subscribed`

A stream devices get only when the app subscribes, which audit does not test. [More](rules/not-auto-subscribed.md)

#### `rls-off`

A synced table whose migrations never enable row level security. [More](rules/rls-off.md)

#### `rls-open`

A policy on a synced table that lets any client or any signed-in user through. [More](rules/rls-open.md)

### `audit`

```console
$ npx samesight audit --sync-config powersync/sync-config.yaml
```

Runs `samesight-verify audit` with the arguments after `audit`: the project's own RLS against its own sync config, on the local stack, with generated data, real users and headless devices. Where lint reads the files, audit tests the rows. Every flag is `samesight-verify audit`'s (`samesight audit --help` lists them), and so are the exit codes; a run stopped by a signal exits 128 plus its number (130 for Ctrl+C). A SIGINT, SIGTERM or SIGHUP sent to `samesight` alone is passed on to the audit (not on Windows, where the console's Ctrl+C, Ctrl+Break and close reach both processes). When `@samesight/verify` cannot be found or cannot be started it exits 2 with the install command, and with `--json` it also writes a short document saying so on stdout: samesight's own (`tool`, `version`, `mode`, `result`, `exitCode`, `durationMs`, `sections`, `error`), which does not follow `report.schema.json`. See [the verifier](verify.md) for what it checks and what it needs.

`audit` must be the first argument: `samesight audit --sync-config ...`, not `samesight --sync-config ... audit`.

It needs `@samesight/verify`, which `samesight` does not install (`npm install -D @samesight/verify`). It looks for it in the current directory's project (its `node_modules`, then those of the parent directories), then next to `samesight`, then for `samesight-verify` on the PATH, and when it finds none it says so and exits 2. `--project` does not change where it looks, so run `samesight audit` from the directory where `@samesight/verify` is installed. `npx @samesight/verify audit` runs it without installing it, though audit still needs the Supabase CLI in the project or on the PATH.

## `samesight-verify`

From `@samesight/verify`. See [the verifier](verify.md) for what each step does.

```text
samesight-verify [--policy <file>] [--powersync <url>] [--compose <file>]
                 [--static] [--runs <n>] [--seed <n>] [--time-limit <s>]
                 [--mutate] [--mutate-datasets <n>] [--restart <command>]
                 [--json] [--report <file>]
samesight-verify audit [--sync-config <file>] [--project <dir>] [--publication <name>]
                       [--powersync <url> | --keep-powersync] [--compose <file>]
                       [--static] [--runs <n>] [--seed <n>] [--time-limit <s>]
                       [--json] [--report <file>]
```

In audit, a `--publication` other than `powersync` needs `--powersync` or `--static` (the PowerSync audit starts always replicates `powersync`), as does `--compose`, and `--keep-powersync` goes with neither.

## Policy files and module types

Node loads a `.ts` file as an ES module only when the nearest `package.json` says `"type": "module"`. Without a `type`, it loads anyway after a warning; under `"type": "commonjs"`, it cannot load the policy's imports, and the CLI says so. `samesight.policy.mts` always loads as a module, which is why `init` writes that name in such projects.

The policy file runs with Node's type stripping, so it can use types freely but not TypeScript-only runtime syntax (`enum`, `namespace`, parameter properties). Import types with `import type`, and give runtime imports of your own files their `.ts` extension.
