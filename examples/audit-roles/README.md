# Audit: roles and an org in app_metadata

A small app written for Samesight to exercise `samesight-verify audit` on rules that read
token claims. It is modelled on patterns common in public Supabase apps; none is copied.

Orgs own documents, and documents can belong to a team. Who reads a document depends on
the user id, on two claims an admin sets in the user's `app_metadata`, and on two claims a
custom access token hook adds from the user's row in `memberships`:

| Reader | Reads |
|---|---|
| the owner | their own orgs and documents, archived ones included |
| `app_metadata.role = 'editor'` | published documents |
| `app_metadata.role = 'admin'` | every org, and every document that is not archived |
| `app_metadata.org_id` | that org, and its documents that are not archived |
| `team_role = 'lead'` (from the hook) | their team's documents (`team_id`, from the hook) that are not archived |

The hook, `public.custom_access_token_hook`, is enabled in `supabase/config.toml`. It runs
as `supabase_auth_admin`, which gets `usage` on `public`, `select` on `memberships` and an
RLS policy of its own there; no API role (`anon`, `authenticated`, `service_role`) may execute it. Audit gives each run user but
the last a membership before they sign in (two teams, both roles), so the hook adds
different claims to their tokens, and keeps those rows until the run ends. Auth reads the
hook settings when it starts: after changing them, restart the stack (`stack:down`, then
`stack:up`).

The RLS is in [`supabase/migrations`](supabase/migrations), with a restrictive policy
keeping archived documents to their owner. [`sync-config.yaml`](sync-config.yaml) gives
the same access as sync streams, reading the role in the two spellings seen in real
configs: `auth.parameter('$.app_metadata.role')` and `auth.parameter('app_metadata') ->> 'role'`,
and the hook's claims as `auth.parameter('team_id')` and `auth.parameter('team_role')`.

Only Supabase is started by hand (ports 573xx). Each audit starts its own PowerSync
service for the run (it needs Docker) and removes it afterwards; see
[what audit starts and removes](../../docs/verify.md#what-audit-starts-and-removes).
`supabase/config.toml` raises the sign-in rate limit, since every audit signs each of
its users in.

```bash
pnpm --filter audit-roles stack:up             # supabase start, with an ES256 signing key
pnpm --filter audit-roles verify               # must pass, every rule seen allowing and refusing: users hold each role, org, team and team role
pnpm --filter audit-roles verify:planted       # must fail: the editor stream loses its status filter
pnpm --filter audit-roles verify:planted-team  # must fail: the team stream loses its lead filter
pnpm --filter @samesight/verify test:roles     # the live tests on this app
pnpm --filter audit-roles stack:down
```
