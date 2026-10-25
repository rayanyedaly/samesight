# Fieldbook

A multi-tenant inspections app for teams that work where the signal drops, built on Supabase and PowerSync. It is the Samesight demo: small, but it exercises every part of the access policy.

- **Roles:** an admin assigns and publishes inspections, an inspector does them, and a viewer (the client) sees only published and archived reports, never the internal notes.
- **Offline:** the app opens and works with no signal. Data lives in an encrypted local database ([`@samesight/next`](../../packages/next)), keyed from the sign-in password, and changes sync when the connection returns.
- **Writes the server refuses are kept and shown.** Each offline transaction uploads as one `apply_batch` call ([`@samesight/supabase`](../../packages/supabase)) and commits or fails as a unit. A refused one leaves the queue, but its content stays on the device in a banner, and the server keeps a copy for admins.
- **Append-only findings:** a finding is never edited or deleted. A correction is a new row that supersedes it, and the UI shows "Amended". An inspection, site or tenant that has findings cannot be deleted; archive it instead.

The access rules currently live in two hand-written files that must agree:

- `supabase/migrations/*_fieldbook_access.sql`: the Postgres RLS policies, the custom access token hook, the append-only trigger and the replication setup. The write path (`*_fieldbook_write_path.sql`: `apply_batch` and `record_rejection`) lists the columns clients may write, which must match those grants.
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
| `pnpm --filter fieldbook test:db` | Runs the database tests in `supabase/tests` (claims hook, RLS reads and writes, append-only rules, `apply_batch`) against the local stack. |
| `pnpm --filter fieldbook build` | Production build with the service worker. It first copies PowerSync's prebuilt database worker to `public/@powersync` (`pnpm assets`; `dev` does the same). |

PowerSync reads `powersync/*.yaml` at startup. After editing the sync config, rerun `stack:up`, which recreates the container.

## Try the offline path

1. Sign in as `inspector@northwind.test` and open **Pier 4 Warehouse → Roof and drainage**.
2. In the browser devtools, switch the network to **Offline**.
3. Add a finding, and amend an existing one. Both show "Not synced yet", and the status chip shows the waiting writes.
4. Switch the network back on. The chip returns to "Synced", and the rows appear in Postgres with server-assigned `seq` numbers.

The service worker is registered only by the production build (`build`, then `start`). There, a reload offline shows the unlock screen, which reopens the local data with your password and no network. Locking also happens after 15 minutes without input; it never deletes anything.

To try the same thing after the access token has expired, stop the containers instead (`docker stop fieldbook-powersync-1 supabase_kong_fieldbook`), wait out the token (15 minutes), and reload. The app opens from local data; after `docker start` of both, it refreshes the token and syncs.

## Try a refused write

1. Sign in as `inspector@northwind.test`, open **Roof and drainage**, and run `docker pause supabase_kong_fieldbook`.
2. Change the status to **Draft**. The chip shows one pending change.
3. As an admin would, publish it on the server: `docker exec supabase_db_fieldbook psql -U postgres -c "update public.\"Inspection\" set status = 'PUBLISHED' where title = 'Roof and drainage'"`.
4. `docker unpause supabase_kong_fieldbook`. Inspectors cannot edit a published inspection, so the server refuses the change; a red banner shows it with its content, and `samesight."RejectedWrite"` holds the server copy.

## Known limits

- **Role changes take up to 15 minutes.** Tenant and role travel in the access token, so removing or demoting a member takes effect at their next token refresh (`jwt_expiry` in `supabase/config.toml`).
- **Internal notes are readable over the REST API by viewers of a published inspection.** The sync stream leaves the column out, but RLS is row-level. A real app would move internal notes to their own table.
- **A password changed on another device** leaves this device's local data under the old password. The unlock screen asks for that one; if it is forgotten, the data on this device can be discarded (changes that never synced are lost) and downloads again.
- **Signing out with unsynced changes discards them,** after a confirmation that says how many. Signing out from the unlock screen keeps them.
- **One tab at a time.** The encrypted store does not coordinate across tabs yet. If another tab signs in as someone else, this tab holds its uploads (they never go up under the other user's session) until it locks.
- **Moving a user to another tenant** refuses their writes still queued from the old tenant; they appear in the banner rather than landing in the new tenant.
- **After an app update, pages open offline only once visited again online.** Cached pages belong to the build that served them.
