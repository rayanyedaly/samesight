# samesight

One access policy for Supabase and PowerSync. Write who can see what once, in TypeScript, and generate both the Postgres row level security and the PowerSync sync streams from it, so the rows a device receives are always the rows RLS would return.

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

- [Getting started](https://github.com/rayanyedaly/samesight/blob/main/docs/getting-started.md)
- [The policy language](https://github.com/rayanyedaly/samesight/blob/main/docs/policy.md)
- [The CLI](https://github.com/rayanyedaly/samesight/blob/main/docs/cli.md)

`samesight/compiler` exposes the compiler's internals for the verifier. It is not a stable API before 1.0.

MIT
