# Quickstart

What [the getting-started guide](../../docs/getting-started.md) produces, kept in CI so the
guide keeps working: a plain Supabase project (`supabase init`) with a common snake_case,
organization-based schema, and a policy that `samesight init` drafted and a few lines made
real.

- [`supabase/migrations/20261026000000_schema.sql`](supabase/migrations/20261026000000_schema.sql):
  organizations, members (one row per user, with an `owner` or `member` role), projects and
  tasks. `created_by` defaults to `auth.uid()` with no foreign key, as many schemas have it.
- [`samesight.policy.ts`](samesight.policy.ts): everyone in an organization reads its
  projects and tasks; owners manage projects; anyone adds tasks, members change only the
  tasks assigned to them, and only owners delete.
- `supabase/config.toml` as `supabase init` wrote it, with three changes from the guide:
  the ports moved to 563xx (so it runs beside the other examples), an Auth signing key,
  and the access token hook turned on.

```bash
pnpm --filter quickstart stack:up         # Supabase on 563xx, PowerSync on 8082
pnpm --filter quickstart policy:explain   # who can do what
pnpm --filter quickstart policy:doctor
pnpm --filter quickstart policy:verify    # the differential, forged writes and the mutation test
pnpm --filter quickstart stack:down
```

`npx samesight explain` on this policy:

```text
               owner   member
organizations  R---    R---
members        R---    r---
projects       RIUD    R---
tasks          rIUD    rIu-
```
