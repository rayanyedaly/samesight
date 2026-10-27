# Audit: roles and an org in app_metadata

A small app written for Samesight to exercise `samesight-verify audit` on rules that read
token claims. It is modelled on patterns common in public Supabase apps; none is copied.

Orgs own documents. Who reads a document depends on the user id and on two claims an
admin sets in the user's `app_metadata`:

| Reader | Reads |
|---|---|
| the owner | their own orgs and documents, archived ones included |
| `app_metadata.role = 'editor'` | published documents |
| `app_metadata.role = 'admin'` | every org, and every document that is not archived |
| `app_metadata.org_id` | that org, and its documents that are not archived |

The RLS is in [`supabase/migrations`](supabase/migrations), with a restrictive policy
keeping archived documents to their owner. [`sync-config.yaml`](sync-config.yaml) gives
the same access as sync streams, reading the role in the two spellings seen in real
configs: `auth.parameter('$.app_metadata.role')` and `auth.parameter('app_metadata') ->> 'role'`.

Only Supabase is started by hand (ports 573xx). Each audit starts its own PowerSync
service for the run (it needs Docker) and removes it afterwards; see
[what audit starts and removes](../../docs/verify.md#what-audit-starts-and-removes).
`supabase/config.toml` raises the sign-in rate limit, since every audit signs each of
its users in.

```bash
pnpm --filter audit-roles stack:up             # supabase start, with an ES256 signing key
pnpm --filter audit-roles verify               # must pass; run users hold admin, editor and another role
pnpm --filter audit-roles verify:planted       # must fail: the editor stream loses its status filter
pnpm --filter @samesight/verify test:roles     # the live tests on this app
pnpm --filter audit-roles stack:down
```
