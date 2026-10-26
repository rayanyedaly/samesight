# @samesight/verify

Proves, against your local Supabase and PowerSync stack, that no device receives a row Postgres RLS would refuse to show its user.

```bash
npm install -D @samesight/verify
npx samesight-verify            # with a samesight policy
npx samesight-verify --mutate   # and show the tests would catch a weakened rule
npx samesight-verify audit --sync-config powersync/sync-config.yaml   # hand-written RLS and sync streams
```

PowerSync replicates with a role that bypasses RLS, so the sync config is the only filter between your tables and a device. When it and your RLS disagree, nothing errors: a device just holds rows its user should never see. This finds that, by running the real thing:

1. **Static checks**: generated files match the policy, every stream query carries the tenant gate, the client schema covers every synced table, and PowerSync is 1.20.1 or newer.
2. **Catalog checks**: RLS, policies, grants, `anon` reach, role bypasses, views, the token hook and the publication, plus a rolled-back re-apply of the generated migration that names any drift.
3. **Differential test**: real users for every role, generated data (fast-check, shrunk on failure), a headless PowerSync device per user, and RLS reads with the same token. Every synced row must be one RLS returns, and every RLS row must sync.
4. **Write path**: forged upload batches (other tenants, forged authors, append-only edits, protected columns, replays, self-promotion) must be refused.
5. **Mutation test** (`--mutate`): each rule in the RLS and the sync config is weakened in turn, and the differential must catch every one.

**Audit mode** (`samesight-verify audit`) runs the catalog checks, the differential and a write check on any Supabase + PowerSync project, with no Samesight policy. It reads Edition 3 sync streams and legacy sync rules (`bucket_definitions`).

It refuses to run against anything but this machine: every address must be local, `NODE_ENV` must be `development` or `test`, and hosting platform variables must be absent. It reads addresses and keys from `supabase status`, using the Supabase CLI in `node_modules/.bin` or on your PATH. Needs Node 22.18 or newer and Docker.

- [The verifier and audit mode](https://github.com/rayanyedaly/samesight/blob/main/docs/verify.md)
- [Getting started](https://github.com/rayanyedaly/samesight/blob/main/docs/getting-started.md)

MIT
