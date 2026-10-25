# Fieldbook

A multi-tenant inspections app for teams that work where the signal drops, built on Supabase and PowerSync. It is the Samesight demo: small, but it exercises every part of the access policy.

- **Roles:** an admin assigns and publishes inspections, an inspector does them, and a viewer (the client) sees only published and archived reports, never the internal notes.
- **Offline:** findings recorded with no signal are kept on the device and sync when the connection returns.
- **Append-only findings:** a finding is never edited or deleted. A correction is a new row that supersedes it, and the UI shows "Amended". An inspection, site or tenant that has findings cannot be deleted; archive it instead.

The access rules currently live in two hand-written files that must agree:

- `supabase/migrations/*_fieldbook_access.sql`: the Postgres RLS policies, the custom access token hook, the append-only trigger and the replication setup.
- `powersync/sync-config.yaml`: the PowerSync sync streams, one per role.

Samesight's compiler will generate both from one policy file.

## Run it locally

You need Node 22.18 or newer, pnpm 10 and Docker. From the repository root:

```bash
pnpm install
pnpm --filter fieldbook stack:up   # Supabase + PowerSync in Docker; first run pulls images
pnpm --filter fieldbook seed       # two tenants, one user per role
pnpm --filter fieldbook dev        # http://127.0.0.1:3000
```

Sign in as `admin@`, `inspector@` or `viewer@` followed by `northwind.test` or `harbor.test`. The password for every account is `fieldbook-demo`. These are local demo accounts only, and the seed script refuses to run against anything but the local stack.

| Command | What it does |
| --- | --- |
| `pnpm --filter fieldbook stack:up` | Starts Supabase and the PowerSync service. It generates the ES256 signing key and the local passwords on first run, and writes the gitignored `.env` and `.env.local`. |
| `pnpm --filter fieldbook stack:down` | Stops both and keeps the data. |
| `pnpm --filter fieldbook db:reset` | Wipes the data, reapplies the migrations and reseeds. |
| `pnpm --filter fieldbook test:db` | Runs the database tests in `supabase/tests` (claims hook, RLS reads and writes, append-only rules) against the local stack. |

PowerSync reads `powersync/*.yaml` at startup. After editing the sync config, rerun `stack:up`, which recreates the container.

## Try the offline path

1. Sign in as `inspector@northwind.test` and open **Pier 4 Warehouse → Roof and drainage**.
2. In the browser devtools, switch the network to **Offline**.
3. Add a finding, and amend an existing one. Both show "Not synced yet", and the status chip shows the waiting writes.
4. Switch the network back on. The chip returns to "Synced", and the rows appear in Postgres with server-assigned `seq` numbers.

To try the same thing after the access token has expired, stop the containers instead (`docker stop fieldbook-powersync-1 supabase_kong_fieldbook`), wait out the token (15 minutes), and reload. The app opens from local data and shows "Offline"; after `docker start` of both, it refreshes the token and syncs.

## Known limits

- **Role changes take up to 15 minutes.** Tenant and role travel in the access token, so removing or demoting a member takes effect at their next token refresh (`jwt_expiry` in `supabase/config.toml`).
- **Internal notes are readable over the REST API by viewers of a published inspection.** The sync stream leaves the column out, but RLS is row-level. A real app would move internal notes to their own table.
- **Rejected writes are dropped.** A write the server refuses (for example, a finding added offline to an inspection that was reassigned meanwhile) is logged to the console and discarded. Phase 2 keeps such writes and shows them.
