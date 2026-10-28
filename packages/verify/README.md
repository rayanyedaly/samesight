# @samesight/verify

PowerSync replicates with a role that bypasses Postgres row level security, so the sync config is the only filter between your tables and a device. When the sync config is wider than RLS, nothing fails: devices quietly hold rows their users may not read. This package finds those rows, against your local Supabase and PowerSync stack (audit mode can start its own PowerSync).

Audit a project with hand-written RLS and a hand-written sync config, with no Samesight policy. It needs the project's local Supabase stack and Docker. `samesight audit`, from the [`samesight`](https://www.npmjs.com/package/samesight) CLI, forwards to `samesight-verify audit`:

```bash
npm install -D samesight @samesight/verify supabase
npx supabase start
npx samesight audit --project . --sync-config sync-config.yaml
# the same run: npx samesight-verify audit --project . --sync-config sync-config.yaml
```

![samesight audit on the to-do list demo with a leak planted: it fails, names the stream query that sent another user's list, the RLS policy that refused it, and the filter to add](https://raw.githubusercontent.com/rayanyedaly/samesight/main/docs/assets/audit-demo-light.svg)

With a samesight policy, it checks that the generated RLS and sync streams agree:

```bash
npx samesight-verify            # static, catalog, differential, write path
npx samesight-verify --mutate   # and show the tests would catch a weakened rule
```

With a policy, it runs:

1. **Static checks**: generated files match the policy, every stream query carries the tenant gate, the client schema covers every synced table, and PowerSync is 1.20.1 or newer.
2. **Catalog checks**: RLS, policies, grants, `anon` reach, role bypasses, views, the token hook and the publication, plus a rolled-back re-apply of the generated migration that names any drift.
3. **Differential test**: real users for every role, generated data (fast-check, shrunk on failure), a headless PowerSync device per user, and RLS reads with the same token. Every synced row must be one RLS returns, and every RLS row must sync.
4. **Write path**: forged upload batches (other tenants, forged authors, append-only edits, protected columns, replays, self-promotion) must be refused.
5. **Mutation test** (`--mutate`): each rule in the RLS and the sync config is weakened in turn, and the differential must catch every one.

**Audit mode** (`samesight-verify audit`) runs the catalog checks, the differential and a write check on any Supabase + PowerSync project, with no Samesight policy. It reads Edition 3 sync streams and legacy sync rules (`bucket_definitions`). It needs only `supabase start` and Docker: unless given `--powersync`, it starts a PowerSync service of its own for the run (the official FSL-licensed image, pulled once, never redistributed) and removes it, and everything it made, at the end (unless `--keep-powersync` keeps it for the next audit). Its run users hold the `app_metadata` values the rules compare (roles, an org id), and a Coverage section says which policies and streams were seen both allowing and refusing a row.

It refuses to run against anything but this machine: every address must be local, `NODE_ENV` must be `development` or `test`, and hosting platform variables must be absent. It reads addresses and keys from `supabase status`, using the Supabase CLI in `node_modules/.bin` or on your PATH. Needs Node 22.18 or newer, and Docker when audit starts PowerSync.

- [The verifier and audit mode](https://github.com/rayanyedaly/samesight/blob/main/docs/verify.md)
- [How sync configs leak](https://github.com/rayanyedaly/samesight/blob/main/docs/how-sync-configs-leak.md)
- [CI and the GitHub Action](https://github.com/rayanyedaly/samesight/blob/main/docs/ci.md)
- [Getting started](https://github.com/rayanyedaly/samesight/blob/main/docs/getting-started.md)

MIT
