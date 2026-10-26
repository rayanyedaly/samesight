# The CLIs

Both CLIs need Node 22.18 or newer. They find the policy file in the current directory (`samesight.policy.ts`, else `samesight.policy.mts`) unless `--policy` names one, and every path in the policy is relative to the policy file.

## `samesight`

From the `samesight` package.

| Command | Database | What it does |
| --- | --- | --- |
| `samesight init` | optional | Drafts a policy file from the local database, or writes a template without one. Refuses to overwrite an existing policy. |
| `samesight generate` | required | Reads the schema in one read-only transaction and writes every generated file. Adds a migration only when its content changes. |
| `samesight check` | no | Regenerates from the saved schema snapshot and fails if any file on disk differs. For CI. |
| `samesight doctor` | required | Checks the running database against the policy. |
| `samesight explain` | no | Prints who can read and write what, in plain words, from the saved snapshot. |

| Option | |
| --- | --- |
| `--policy <file>` | The policy file. |
| `--db <url>` | The local database. Default: `$SAMESIGHT_DB_URL`, else the `[db]` port in `supabase/config.toml` next to the policy, else the Supabase CLI's default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. |
| `--table <name>` | `explain` only: one table. |
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

Exit code 1 and a list of stale files when anything differs. It needs no database, so it runs anywhere your type check runs.

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
```

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

## `samesight-verify`

From `@samesight/verify`. See [the verifier](verify.md) for what each step does.

```text
samesight-verify [--policy <file>] [--powersync <url>] [--compose <file>]
                 [--static] [--runs <n>] [--seed <n>] [--time-limit <s>]
                 [--mutate] [--mutate-datasets <n>] [--restart <command>]
samesight-verify audit [--sync-config <file>] [--project <dir>] [--publication <name>]
                       [--powersync <url>] [--compose <file>]
                       [--static] [--runs <n>] [--seed <n>] [--time-limit <s>]
```

## Policy files and module types

Node loads a `.ts` file as an ES module only when the nearest `package.json` says `"type": "module"`. Without a `type`, it loads anyway after a warning; under `"type": "commonjs"`, it cannot load the policy's imports, and the CLI says so. `samesight.policy.mts` always loads as a module, which is why `init` writes that name in such projects.

The policy file runs with Node's type stripping, so it can use types freely but not TypeScript-only runtime syntax (`enum`, `namespace`, parameter properties). Import types with `import type`, and give runtime imports of your own files their `.ts` extension.
