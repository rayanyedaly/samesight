# samesight

PowerSync replicates with a role that bypasses Postgres row level security, so the sync config is the only filter between your tables and a device. When the sync config is wider than RLS, nothing fails: devices quietly hold rows their users may not read. `samesight` catches that.

Lint the sync config and the SQL migrations for known leak patterns. It reads files only: no database, no Docker, no policy file.

```bash
npx samesight lint sync-config.yaml --migrations supabase/migrations
```

Audit the rows themselves: test users, generated rows and a real PowerSync device per user, each device's rows compared with what RLS returns for the same user. `samesight audit` runs `samesight-verify audit`, so it needs [`@samesight/verify`](https://www.npmjs.com/package/@samesight/verify) installed, the project's local Supabase stack and Docker:

```bash
npm install -D samesight @samesight/verify supabase
npx supabase start
npx samesight audit --project . --sync-config sync-config.yaml
```

![samesight audit on the to-do list demo with a leak planted: it fails, names the stream query that sent another user's list, the RLS policy that refused it, and the filter to add](https://raw.githubusercontent.com/rayanyedaly/samesight/main/docs/assets/audit-demo-light.svg)

[How sync configs leak](https://rayanyedaly.github.io/samesight/how-sync-configs-leak) walks through the patterns, and [CI and the GitHub Action](https://rayanyedaly.github.io/samesight/ci) runs both on pull requests.

## One policy for both sides

Write who can see what once, in TypeScript, and generate both the Postgres row level security and the PowerSync sync streams from it, so the rows a device receives are always the rows RLS would return.

```bash
npm install samesight
npx samesight init       # draft samesight.policy.ts from your local database
npx samesight generate   # migration, sync config, client schema
npx samesight explain    # who can do what, in plain words
npx samesight check      # in CI: fail when generated files drift from the policy
```

```ts
import { claim, col, definePolicy, table, via } from "samesight";
import type { Database } from "./supabase/types.ts";

export default definePolicy<Database>({
  auth: "supabase",
  claims: { tenant: claim.uuid("tenant_id"), role: claim.oneOf("app_role", ["ADMIN", "MEMBER"]) },
  membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" },
  tables: {
    Membership: table({ tenant: "tenantId", read: { ADMIN: true, MEMBER: col("userId").eq(claim.user) } }),
    Project: table({ tenant: "tenantId", read: { "*": true }, write: { ADMIN: true } }),
    Task: table({
      tenant: "tenantId",
      read: { "*": via("projectId", "Project") },
      write: { ADMIN: true, MEMBER: col("assigneeId").eq(claim.user) },
    }),
  },
});
```

`generate` writes a Supabase migration (RLS policies, column grants, the access token hook that puts tenant and role in the token, append-only and timestamp triggers, the replication role and publication, and a transactional `apply_batch` write path), PowerSync Edition 3 sync streams, and the PowerSync client schema. It only ever connects to a database on this machine.

Pair it with [`@samesight/verify`](https://www.npmjs.com/package/@samesight/verify), which runs your local stack and proves no device receives a row RLS would refuse.

Needs Node 22.18 or newer: the policy file is loaded as TypeScript with Node's type stripping, with no build step.

- [Getting started](https://rayanyedaly.github.io/samesight/getting-started)
- [The policy language](https://rayanyedaly.github.io/samesight/policy)
- [The CLI](https://rayanyedaly.github.io/samesight/cli)
- [The verifier and audit mode](https://rayanyedaly.github.io/samesight/verify)
- [How sync configs leak](https://rayanyedaly.github.io/samesight/how-sync-configs-leak)
- [CI and the GitHub Action](https://rayanyedaly.github.io/samesight/ci)

`samesight/compiler` exposes the compiler's internals for the verifier. It is not a stable API before 1.0.

MIT
