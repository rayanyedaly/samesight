# Samesight

**Your database and your devices see the same rows.**

[![CI](https://github.com/rayanyedaly/samesight/actions/workflows/ci.yml/badge.svg)](https://github.com/rayanyedaly/samesight/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/samesight.svg)](https://www.npmjs.com/package/samesight)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An offline-first app on Supabase and PowerSync has two access policies. Postgres row level security decides what a user can read over the API. The PowerSync sync config decides what lands on their device. PowerSync replicates with a role that bypasses RLS, so the sync config is the only filter between your tables and a phone. When the two drift apart, nothing fails: a device quietly holds rows its user was never allowed to see, or never gets rows it should have.

Samesight closes that gap.

- **Write the policy once.** A typed `samesight.policy.ts` says who reads and writes what, per role, inside each tenant. Table and column names are checked by your editor against `supabase gen types`.
- **Generate both sides from it.** `samesight generate` writes the RLS migration (policies, grants, the access token hook, triggers, a transactional write path) and the PowerSync sync streams, plus the client schema, all from one condition tree. `samesight check` fails CI when anything drifts.
- **Prove they agree.** `samesight-verify` runs your real stack: it creates users, generates data, syncs real headless devices and compares every row each device got with what RLS returns for the same user. It forges upload batches, and it mutates the access layer to show its own tests would catch a weakened rule.
- **Or audit what you already have.** `samesight-verify audit` runs the same differential on a project with hand-written RLS and a hand-written sync config (sync streams or legacy sync rules), with no policy file.

```ts
// samesight.policy.ts
import { claim, col, definePolicy, table, via } from "samesight";
import type { Database } from "./supabase/types.ts";

export default definePolicy<Database>({
  auth: "supabase",
  claims: { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["ADMIN", "INSPECTOR", "VIEWER"]) },
  membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" },
  tables: {
    Tenant: table({ tenant: "id", read: { "*": true } }),
    Membership: table({ tenant: "tenantId", read: { ADMIN: true, "*": col("userId").eq(claim.user) } }),
    Inspection: table({
      tenant: "tenantId",
      read: { ADMIN: true, INSPECTOR: col("assigneeId").eq(claim.user), VIEWER: col("status").in(["PUBLISHED"]) },
      write: { ADMIN: true },
      hide: { VIEWER: ["internalNotes"] },
      serverOwned: ["createdAt"],
      touch: "updatedAt",
    }),
    Finding: table({
      tenant: "tenantId",
      read: { "*": via("inspectionId", "Inspection") },
      insert: { INSPECTOR: via("inspectionId", "Inspection") },
      author: "createdBy",
      serverOwned: ["createdAt"],
      appendOnly: { supersedes: "supersedesId" },
    }),
  },
});
```

```console
$ npx samesight explain
R I U D: every row of the tenant   r i u d: some rows   -: none
            ADMIN      INSPECTOR  VIEWER
Tenant      R---       R---       R---
Membership  R---       r---       r---
Inspection  RIUD       r---       r---
Finding     r---       ri--       r---

Inspection (tenant column tenantId)
  read:
    ADMIN: every row
    INSPECTOR: rows where assigneeId = the signed-in user
    VIEWER: rows where status = PUBLISHED
  ...
  never synced to VIEWER: internalNotes (still readable over the REST API; RLS is per row)
```

## Get started

You need Node 22.18 or newer, the Supabase CLI with a local stack (`supabase start`), and Docker for the PowerSync service.

```bash
npm install samesight @samesight/supabase
npm install -D @samesight/verify

npx samesight init         # drafts samesight.policy.ts from your local database
supabase gen types typescript --local --schema public > supabase/types.ts
npx samesight generate     # migration, sync streams, client schema
npx samesight explain      # who can do what, in plain words
npx samesight-verify       # prove devices and RLS agree, against the local stack
```

The [getting started guide](docs/getting-started.md) walks through it, including the Supabase hook and the PowerSync service.

Already running PowerSync with hand-written RLS? Lint your sync config in seconds, with nothing to set up:

```bash
npx samesight lint powersync/sync-config.yaml
```

Then test the rows themselves. With the project's local Supabase stack running and Docker, the verifier starts a PowerSync service of its own for the run and removes it afterwards:

```bash
npx supabase start
npx @samesight/verify audit --sync-config powersync/sync-config.yaml
```

See [auditing an existing project](docs/verify.md#audit-mode).

## Packages

| Package | What it is |
| --- | --- |
| [`samesight`](packages/samesight) | The policy language, the compiler and the `samesight` CLI (`init`, `generate`, `check`, `doctor`, `explain`, and `lint` for any PowerSync sync config). |
| [`@samesight/verify`](packages/verify) | `samesight-verify`: static and catalog checks, the differential test, forged writes and the mutation test; `audit` for projects without a policy. |
| [`@samesight/supabase`](packages/supabase) | A PowerSync connector for Supabase: one atomic `apply_batch` call per transaction, error classification, and refused writes kept instead of lost. |
| [`@samesight/next`](packages/next) | For Next.js: a per-user encrypted local database, offline unlock, idle lock, safe sign-out, and sync status UI. |

`samesight` and `@samesight/verify` are what you need for the policy. The runtime packages are optional; the generated client schema imports one table definition from `@samesight/supabase`.

## Docs

- [Getting started](docs/getting-started.md)
- [The policy language](docs/policy.md)
- [The CLIs](docs/cli.md)
- [The verifier and audit mode](docs/verify.md)
- [Fieldbook](examples/fieldbook), the example app: multi-tenant inspections with three roles, offline writes and append-only records
- [Quickstart](examples/quickstart): what the getting-started guide produces, verified in CI
- [Changelog](CHANGELOG.md)

## What it does not do

- **Hosted databases are never touched.** Every command that connects refuses anything but this machine. You ship the generated migration with `supabase db push` and the sync config to your PowerSync instance as usual.
- **One tenant per user, from a membership table.** The tenant and role travel in the access token, so a membership change takes effect at the next token refresh.
- **RLS is per row.** A column hidden from a role's devices is still readable by that role over the REST API. `samesight explain` says so next to every hidden column.
- **Generates sync streams (Edition 3).** Audit mode reads both sync streams and legacy `bucket_definitions` sync rules, but `generate` writes streams only.
- **Pre-1.0.** The policy language may change between minor versions; the changelog will say how to move.

## Develop

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # no services needed
pnpm smoke                                   # pack, install with npm, use as a user would
pnpm --filter fieldbook stack:up             # Supabase + PowerSync for the stack tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, the test tiers and how releases are cut.

## License

MIT. The PowerSync service image (FSL-1.1-ALv2) is never bundled or redistributed: the examples run it for local development and CI, and `samesight-verify audit` pulls the official image and runs it on your machine.
