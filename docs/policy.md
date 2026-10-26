# The policy language

A policy file default-exports `definePolicy<Database>({...})`, where `Database` is the type `supabase gen types` writes. Everything in it is plain data: the compiler checks it against the database schema and renders the same condition tree twice, once as Postgres RLS and once as PowerSync sync streams.

```ts
import { and, claim, col, definePolicy, or, raw, rowsOf, table, via } from "samesight";
import type { Database } from "./supabase/types.ts";

export default definePolicy<Database>({
  auth: "supabase",
  claims: { ... },
  membership: { ... },
  tables: { ... },
  rejectedWrites: { ... },   // optional
  output: { ... },           // optional
  client: { ... },           // optional
});
```

When the compiler refuses something, it names the rule and the reason, and lists every problem at once:

```text
The policy does not compile:
  - Inspection.read.VIEWER: true does not fit "archived" (boolean); it takes nothing in a read rule (PowerSync syncs booleans as 0/1; use raw)
  - Finding.read.INSPECTOR: via must stand alone or be a term of a top-level and(); sync streams cannot put it under or() (rules for "*" and for a role are ORed together)
```

## Claims and membership

```ts
claims: {
  tenant: claim.uuid("tenant_id"),
  role: claim.oneOf("app_role", ["ADMIN", "INSPECTOR", "VIEWER"]),
},
membership: { table: "Membership", user: "userId", tenant: "tenantId", role: "role" },
```

At sign-in, the generated access token hook looks the user up in the membership table and adds two claims to the token: the tenant and the role. RLS reads them with `auth.jwt()`, and the sync streams with `auth.parameter()`.

- Claim names are lowercase. Names Supabase sets itself (`role`, `sub`, `email`, `aud` and the like) are refused, which is why the role claim is usually `app_role`.
- Roles are identifiers. Each one names a sync stream, lowercased.
- The membership `user` column must be unique: one tenant and one role per user.
- The membership table must be in `tables` with a read rule, so each user can at least read their own row.

A membership change takes effect when the user's token is next refreshed.

## Tables

Every table in `tables` gets RLS, and every table with a read rule is synced. Table and column names are checked against `Database` in your editor and against the live schema by the compiler.

```ts
Inspection: table({
  tenant: "tenantId",
  read: { ADMIN: true, INSPECTOR: col("assigneeId").eq(claim.user) },
  write: { ADMIN: true },
}),
```

Requirements on each table:

- a single primary key column named `id`;
- a `tenant` column that is uuid and NOT NULL (the tenant table itself says `tenant: "id"`), or `tenant: null` for a shared table (below);
- a name of letters, digits and underscores, at most 48 characters.

### Shared tables

Reference data every tenant reads the same way (plans, countries, categories, labels) has no tenant column. Say so with `tenant: null`:

```ts
labels: table({ tenant: null, read: { owner: true, member: col("status").eq("active") } }),
```

Its RLS policy and stream queries carry the role gate and the rule, and no tenant gate. A shared table is read-only to clients: write rules, `check`, `serverOwned`, `immutable`, `author`, `touch` and `appendOnly` are refused, so its rows come from migrations or the service role. Its own read rules cannot use `via` or `rowsOf`, but a tenant table's rules can read through it. The membership table cannot be shared.

The verifier generates rows for a shared table keyed by a uuid `id`, like any other. One keyed otherwise (a country code, say) gets no generated rows: the rows already in the database are compared, and the run warns if no user could read any.

### Rules

| Key | Meaning |
| --- | --- |
| `read` | Who reads which rows. Becomes the SELECT policy and the sync stream queries. |
| `insert` | Who inserts which rows (WITH CHECK). |
| `update` | Who updates which rows. The condition holds before (USING) and after (WITH CHECK) the change. |
| `delete` | Who deletes which rows. |
| `write` | Shorthand for the same rule on insert, update and delete, ORed with any rule they also have. |
| `check` | A condition every inserted or updated row must meet, whatever the role (WITH CHECK only). |

Each takes an object keyed by role, or `"*"` for every role. A value is `true` (every row of the tenant) or a condition. Rules for `"*"` and for a role are ORed. A role with no rule has no access for that operation.

Every rule is ANDed with the tenant gate (`tenant column = the tenant claim`) and the role gate. You never write either. A shared table has the role gate only.

A role that writes a table must also read it: upserts and replays read the row back under the SELECT policy. The tenant table cannot be written by clients.

### Conditions

| Builder | Meaning | Notes |
| --- | --- | --- |
| `col("c").eq(value)` | `c = value` | `value` is a literal, or `claim.user` (the signed-in user's id; the column must be uuid). |
| `col("c").in([a, b])` | `c` is one of a fixed list | An empty list is refused. |
| `col("c").in(rowsOf("T", "k", where?))` | `c` is the `k` of a row of `T` the user can read, optionally matching `where` | For sharing and assignment tables. `T` must be in the policy. In read rules, limited like `via` (below). |
| `col("c").isNull()`, `.isNotNull()` | | |
| `via("c", "Parent", { key? })` | Readable when the `Parent` row that `c` points to (by `key`, default `id`) is readable by the same user | See below. |
| `and(...)`, `or(...)` | | Nested groups are flattened. |
| `raw({ rls, sync })` | Hand-written SQL for each side | See below. |

Literals must fit the column, because Postgres casts a mismatch but PowerSync compares replicated values as they are:

- text columns take strings, integer columns integers, float columns numbers, uuid columns lowercase canonical uuid strings;
- booleans are allowed in write rules but not in read rules (PowerSync syncs them as 0 and 1; use `raw`);
- timestamps, dates, intervals and `numeric` take no literal at all, since the two sides would compare them differently. Scope by a status column instead.
- strings cannot contain quotes, backslashes, `#` or control characters.

Annotate shared conditions with the columns they use so they fit a typed table, or let TypeScript infer them:

```ts
const ownOpen = and(col("assigneeId").eq(claim.user), col("status").in(["DRAFT", "IN_PROGRESS"]));
```

### Reading through a parent: `via`

```ts
Finding: table({
  tenant: "tenantId",
  read: { "*": via("inspectionId", "Inspection") },
}),
```

A finding is readable exactly when its inspection is. In RLS that is an `IN (select id from "Inspection")` that runs under the parent's own policy; in the sync streams it is a CTE with the parent's rule for the same role. Because the streams have to express it, `via` is limited:

- at most one `via` or `rowsOf` per read rule, standing alone or as a term of a top-level `and()`, never under `or()` (rules for `"*"` and for a role are ORed, so a `via` for `"*"` and another rule for a role do not mix);
- the parent's rule for the same role cannot itself use `via` or `rowsOf`;
- the parent must be in the policy, and the role must have a read rule on it;
- tables cannot reach each other in a cycle through `via` or `rowsOf`.

Index the `via` column; the compiler warns when it is not. A composite foreign key `(tenant, column) -> parent (tenant, id)` on a NOT NULL column lets the generated stream drop the subquery where the parent is read entirely, and lets the verifier prove the shortcut is safe.

### Reading through a sharing table: `rowsOf`

```ts
const myProjects = rowsOf("project_members", "project_id", col("user_id").eq(claim.user));

projects: table({ tenant: "org_id", read: { owner: true, member: col("id").in(myProjects) } }),
tasks: table({ tenant: "org_id", read: { owner: true, member: col("project_id").in(myProjects) } }),
project_members: table({ tenant: "org_id", read: { owner: true, member: col("user_id").eq(claim.user) } }),
```

A member reads the projects they were added to, and those projects' tasks. `rowsOf(table, column, where)` is the `column` of the rows of `table` the user can read that match `where`: in RLS a subquery that runs under that table's own policy, in the streams a CTE that repeats that table's rule for the role plus `where`. The limits are `via`'s, and `where` cannot use `via` or `rowsOf` itself. The verifier proves the CTE and the subquery agree, like any other rule; index the columns `where` filters on (the compiler warns otherwise). [The quickstart](../examples/quickstart) uses exactly this.

### Escape hatch: `raw`

```ts
read: { VIEWER: raw({ rls: `"publishedAt" is not null`, sync: `"publishedAt" IS NOT NULL` }) }
```

Both sides are wrapped in parentheses and ANDed with the tenant and role gates. To keep a raw rule from escaping that wrapper, the compiler refuses comments, `;`, `$`, `\`, unbalanced parentheses and unclosed quotes. It also refuses anything that reads the clock (`now()`, `current_date` and the like), because sync buckets are not re-evaluated as time passes. The verifier tests raw rules like any other; nothing proves the two sides agree except that run.

## Columns

| Key | Meaning |
| --- | --- |
| `hide: { ROLE: ["col"] }` | Left out of that role's sync stream; `"*"` hides from every role. RLS is per row, so the role can still read the column over the REST API. A role that updates the table can only hide columns it cannot write (immutable or server-owned), or it would write them back as null. `id` and the tenant column cannot be hidden. |
| `serverOwned: ["col"]` | Clients never write it; `apply_batch` drops it from every write and the column grants leave it out. It needs a default if it is NOT NULL. |
| `immutable: ["col"]` | Clients may set it on insert but never change it. |
| `author: "col"` | Set to the signed-in user. The column needs the default `auth.uid()`; inserts must carry exactly that user. |
| `touch: "col"` | Set to `now()` by a trigger on every update. Must be `timestamptz`. |
| `appendOnly: { supersedes?, order? }` | Rows are never updated or deleted, by clients or by the service role (triggers refuse UPDATE, DELETE and TRUNCATE). A correction is a new row whose `supersedes` column names the row it replaces; `latestOnly` in `@samesight/supabase` resolves the chains. `order` is a column the server assigns (identity or default). Only insert rules are allowed. |

The tenant column, identity and generated columns, `author`, `touch` and `order` are server-owned automatically.

## Refused writes

```ts
rejectedWrites: { read: ["ADMIN"] },
```

When the server refuses a write for good, `@samesight/supabase` keeps it on the device and also records it with `record_rejection` in `samesight."RejectedWrite"`. The roles listed here can read their tenant's records there. Default: nobody.

## Output paths

```ts
output: {
  migrations: "supabase/migrations",
  syncConfig: "powersync/sync-config.yaml",
  serviceConfig: "powersync/service.yaml",
  clientSchema: "src/samesight/app-schema.ts",
  policyTypes: "src/samesight/policy-types.ts",
  manifest: "samesight/manifest.json",
  schemaSnapshot: "samesight/schema.json",
},
client: { import: "@powersync/web" },
```

These are the defaults. Paths are relative to the policy file and must stay inside the project. `client.import` is the package the client schema imports `column`, `Schema` and `Table` from: `@powersync/web`, `@powersync/react-native` or `@powersync/node`.

Migration file names must be timestamps (`yyyymmddhhmmss_name.sql`), which is what `supabase migration new` writes. `generate` adds a new migration after the newest one whenever its output changes, and the migration it writes drops and recreates everything it owns, so it is safe to apply on top of an earlier one. A table removed from the policy is closed, not opened: its generated policies and grants are dropped and RLS stays on.
