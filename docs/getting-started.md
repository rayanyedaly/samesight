# Getting started

This guide takes a Supabase project from no policy to a verified one: RLS and PowerSync sync streams generated from one file, and a test run that proves devices only receive rows RLS would return.

It assumes a Supabase CLI project (`supabase/config.toml`, migrations in `supabase/migrations`) that runs locally with `supabase start`. Everything Samesight does happens against that local stack; it never connects to a hosted database.

## What you need

- Node 22.18 or newer. The CLIs load your policy file as TypeScript with Node's built-in type stripping, so there is no build step.
- The Supabase CLI, installed in the project (`npm i -D supabase`) or on your PATH.
- Docker, for the local Supabase stack and the PowerSync service.

Your schema needs three things the policy builds on:

1. **A membership table**: one row per user, with a unique uuid user column, a uuid tenant column and a role column. The access token hook reads it at sign-in and puts the tenant and role in the token.
2. **A tenant column on every table you sync**: uuid and NOT NULL. Every rule is scoped to the user's tenant. The tenant table itself uses its `id`.
3. **A single `id` primary key on every table**, which is how PowerSync identifies rows.

## 1. Install

```bash
npm install samesight @samesight/supabase
npm install -D @samesight/verify
```

`samesight` holds the policy language and the CLI. `@samesight/supabase` is a runtime dependency because the generated client schema imports its `RejectedWrite` table. `@samesight/verify` is only needed in development and CI.

## 2. Draft a policy

With `supabase start` running and your schema migrations applied:

```bash
npx samesight init
```

`init` reads the local database and drafts `samesight.policy.ts`: it finds the membership table, the tenant table, each table's tenant column and the role values (from an enum or a `CHECK (role in (...))`). The draft compiles as written and is deliberately narrow on writes: every role reads every row of its own tenant, each user reads their own membership row, and clients write nothing. Tables it cannot scope are left out with a comment saying why.

Without a running database, `init` writes a template to fill in instead. In a package without `"type": "module"`, it writes `samesight.policy.mts`, which Node always loads as a module; both names are found automatically.

Then generate the database types the policy is checked against:

```bash
npx supabase gen types typescript --local --schema public > supabase/types.ts
```

Rerun that after every schema migration. Your editor now flags unknown table and column names in the policy.

## 3. Write the rules

Each table says who reads and who writes, per role, with `"*"` for every role. Everything is inside the user's tenant already.

```ts
Inspection: table({
  tenant: "tenantId",
  read: {
    ADMIN: true,                                   // every inspection in the tenant
    INSPECTOR: col("assigneeId").eq(claim.user),   // only their own
    VIEWER: col("status").in(["PUBLISHED", "ARCHIVED"]),
  },
  insert: { ADMIN: true },
  update: { ADMIN: true, INSPECTOR: and(col("assigneeId").eq(claim.user), col("status").in(["DRAFT", "IN_PROGRESS"])) },
  delete: { ADMIN: true },
  hide: { VIEWER: ["internalNotes"] },             // never sent to viewers' devices
  serverOwned: ["createdAt"],                      // clients cannot set it
  touch: "updatedAt",                              // set to now() on every update
}),
```

[The policy language](policy.md) covers every option. Check your work in plain words at any point:

```bash
npx samesight explain              # the whole policy
npx samesight explain --table Inspection
```

`explain` reads the saved schema snapshot, so it needs `generate` to have run once.

## 4. Generate

```bash
npx samesight generate
```

This writes, relative to the policy file (each path can be moved with `output` in the policy):

| File | What it is |
| --- | --- |
| `supabase/migrations/<timestamp>_samesight.sql` | RLS policies, column grants, the access token hook, append-only and `touch` triggers, the replication role and publication, and the write path (`apply_batch`, `record_rejection`). A new migration only when the output changes. |
| `powersync/sync-config.yaml` | Edition 3 sync streams, one per role, auto-subscribed. |
| `powersync/service.yaml` | A PowerSync service config for local development. |
| `src/samesight/app-schema.ts` | The PowerSync client schema, one table per synced table. |
| `src/samesight/policy-types.ts` | The roles, claim names and writable columns as TypeScript. |
| `samesight/schema.json`, `samesight/manifest.json` | The schema `generate` read, and hashes the verifier checks. |

Commit all of them. Do not edit them: change the policy and generate again.

Apply the migration to the local database:

```bash
npx supabase migration up
```

## 5. Turn on the access token hook

The generated migration creates `samesight.custom_access_token_hook`, which adds the tenant and role claims to every token. Enable it in `supabase/config.toml`, and give Auth an asymmetric signing key so PowerSync can verify tokens through the JWKS endpoint:

```toml
[auth]
signing_keys_path = "./signing_keys.json"

[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/samesight/custom_access_token_hook"
```

```bash
echo "[]" > supabase/signing_keys.json
npx supabase gen signing-key --algorithm ES256 --append
npx supabase stop && npx supabase start
```

Keep `signing_keys.json` out of git. On a hosted project, enable the hook under Authentication > Hooks instead.

## 6. Run PowerSync locally

The migration creates `powersync_role` (replication, no login) and the `powersync` publication. Give the role a local password and start the PowerSync service next to Supabase. A minimal `docker-compose.yml`, where `<project_id>` is the `project_id` in `supabase/config.toml`:

```yaml
services:
  powersync-storage:
    image: postgres:18
    environment:
      POSTGRES_DB: powersync_storage
      POSTGRES_USER: powersync_storage
      POSTGRES_PASSWORD: ${PS_STORAGE_PASSWORD:?}
  powersync:
    image: journeyapps/powersync-service:latest   # pin a version, 1.20.1 or newer
    command: ["start", "-r", "unified"]
    depends_on: [powersync-storage]
    environment:
      POWERSYNC_CONFIG_PATH: /config/service.yaml
      PS_DATA_SOURCE_URI: postgresql://powersync_role:${PS_REPLICATION_PASSWORD:?}@supabase_db_<project_id>:5432/postgres
      PS_STORAGE_URI: postgresql://powersync_storage:${PS_STORAGE_PASSWORD:?}@powersync-storage:5432/powersync_storage
    volumes:
      - ./powersync:/config:ro
    ports:
      - "127.0.0.1:8080:8080"
    networks: [default, supabase]
networks:
  supabase:
    name: supabase_network_<project_id>
    external: true
```

```bash
export PS_REPLICATION_PASSWORD=$(openssl rand -hex 24) PS_STORAGE_PASSWORD=$(openssl rand -hex 24)
docker exec supabase_db_<project_id> psql -U supabase_admin -d postgres \
  -c "alter role powersync_role with login password '$PS_REPLICATION_PASSWORD'"
docker compose up -d
```

PowerSync 1.20.1 is the floor: before it, `auth.parameter()` gates in sync streams were not enforced. The verifier checks the version your compose file pins. [The quickstart example](../examples/quickstart) is this guide's result, run in CI: its `docker-compose.yml` and `scripts/stack-up.sh` are a complete version of this step, with the images pinned by digest and the passwords kept in a gitignored `.env`.

Then check the whole setup:

```bash
npx samesight doctor
```

`doctor` reports the migration, RLS, the hook, replica identity, the publication, the replication role and the slot's lag, and whether the database still matches the policy.

## 7. Verify

```bash
npx samesight-verify
```

The verifier creates real users for every role in two tenants, fills the tables with generated data, syncs a headless PowerSync device per user, and compares each device's rows with what RLS returns for the same token. Then it forges upload batches: rows for another tenant, forged authors, edits to append-only rows and columns clients may not change. It cleans up after itself on success and failure.

```bash
npx samesight-verify --mutate
```

adds the mutation test: it weakens each rule in the RLS and in the sync config, one at a time, and fails if the differential does not notice. That is what tells you the passing run means something. [The verifier](verify.md) explains each step and its options.

## 8. Wire up the client

The generated client schema plugs into PowerSync, and `SupabaseConnector` uploads each local transaction as one `apply_batch` call:

```ts
import { PowerSyncDatabase } from "@powersync/web";
import { SupabaseConnector } from "@samesight/supabase";
import { AppSchema } from "./samesight/app-schema";

const db = new PowerSyncDatabase({ schema: AppSchema, database: { dbFilename: "app.db" } });
await db.connect(new SupabaseConnector({ supabase, powersyncUrl: "http://127.0.0.1:8080" }));
```

On Next.js, [`@samesight/next`](../packages/next) adds a per-user encrypted store, offline unlock and the sync status UI on top.

## 9. Keep it honest in CI

```bash
npx samesight check
```

`check` regenerates every file from the saved schema snapshot, with no database, and fails if anything on disk differs from what the policy produces. Put it next to your type check. If your CI can run Docker, run the verifier there too; [Fieldbook's CI job](../.github/workflows/ci.yml) starts the stack and runs `samesight-verify --mutate` in under five minutes.

## 10. Ship

- Database: `supabase db push` applies the generated migration like any other.
- Auth: enable the custom access token hook in the dashboard (Authentication > Hooks), pointing at `samesight.custom_access_token_hook`.
- PowerSync: deploy `powersync/sync-config.yaml` to your instance, and connect it as `powersync_role` with a password you set on the hosted database.

`powersync/service.yaml` is for local development only; PowerSync Cloud has its own settings.
