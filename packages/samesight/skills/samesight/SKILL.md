---
name: samesight
description: Checks that a PowerSync sync config sends devices only the rows Supabase RLS would let each user read. Use when creating or editing a PowerSync sync config (sync-config.yaml, sync-rules.yaml, or files under powersync/), when creating or editing Supabase migrations (supabase/migrations/*.sql) that change tables, RLS policies or grants a sync config reads, or when samesight lint findings are reported. Runs `npx samesight lint`, explains each finding and how to fix it, and says when to stop and ask the user.
license: MIT
---

# samesight

This directory is installed by `npx samesight agent init`, which replaces its files when samesight updates them; edit a copy under another name to keep changes.

## What samesight checks

PowerSync replicates past row level security (RLS). The sync config alone decides which rows reach which device: a row the sync config sends is on the device, whatever the RLS policies in Supabase say.

`samesight lint` compares the sync config with the RLS in the project's migrations. It flags rows that reach users RLS would refuse, personal columns sent to users other than the row's owner, and synced tables whose RLS is off or open to everyone.

Lint reads files only. It needs no database, no network and no PowerSync service, and it takes well under a second. Run it as often as you like.

## When to run lint

Run lint after every edit to:

- a sync config: `sync-config.yaml`, `sync-rules.yaml`, or one under `powersync/` (not PowerSync's `service.yaml`);
- a Supabase migration (`supabase/migrations/*.sql`) that creates, alters or drops a table, an RLS policy or a grant.

Run it even when no hook output arrived after your edit. A hook may not be installed, or may not have matched the file.

```bash
npx samesight lint --format json
```

Lint finds the sync config at `sync-config.yaml`, `sync-rules.yaml`, `powersync/sync-config.yaml` or `powersync/sync-rules.yaml`, and the migrations in `supabase/migrations`. When the project keeps them elsewhere, name them:

```bash
npx samesight lint path/to/sync-config.yaml --migrations path/to/migrations --format json
```

Without migrations, lint cannot read RLS: `rls-off` and `rls-open` do not run, and it says so on stderr. Point `--migrations` at the right directory rather than going on without it.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Clean, or only warnings and notes. |
| 1 | At least one error-level finding. |
| 2 | Lint could not run: no sync config found, a bad flag or `--migrations` directory, or a file it could not read. |

On exit 2, fix the command or the file before anything else. A lint that did not run checked nothing.

## Reading findings

Each finding names its rule, its level, a message, and a place in the sync config: file, line and column. Findings always point at the sync config, even when a migration caused them. An `rls-off` finding, for example, is about a table the sync config reads, and it points at the query that reads it; the fix goes in a migration.

The JSON document and each field of a finding are described in [references/json.md](references/json.md).

What to do with each level:

- **error**: fix it before you go on. Rows are reaching users who should not get them.
- **warning**: it may be a real leak or may be deliberate. Explain it to the user and decide with them.
- **info** (a note): information. Mention it if it matters to the task, nothing more.

The rules, and how to fix each one:

<!-- rules -->
| Rule | Level | What it catches | How to fix |
| --- | --- | --- | --- |
| `unscoped-query` | error, or warning | Rows every user receives, because nothing ties them to who is asking. | [references/unscoped-query.md](references/unscoped-query.md) |
| `client-scoped` | error, or warning | Rows picked by what the client sends, with nothing tying them to who is asking. | [references/client-scoped.md](references/client-scoped.md) |
| `user-metadata` | error | Access decided by the token's user_metadata, which every user can set on themselves. | [references/user-metadata.md](references/user-metadata.md) |
| `unreadable-query` | warning | A query samesight-verify audit cannot attribute to one table, so it cannot check it. | [references/unreadable-query.md](references/unreadable-query.md) |
| `not-auto-subscribed` | info | A stream devices get only when the app subscribes, which audit does not test. | [references/not-auto-subscribed.md](references/not-auto-subscribed.md) |
| `rls-off` | warning | A synced table whose migrations never enable row level security. | [references/rls-off.md](references/rls-off.md) |
| `rls-open` | warning | A policy on a synced table that lets any client or any signed-in user through. | [references/rls-open.md](references/rls-open.md) |
| `personal-columns` | warning, or info | A column that likely holds personal data, sent to users other than the row's owner. | [references/personal-columns.md](references/personal-columns.md) |
<!-- /rules -->

Read the rule's reference before you change anything. Each one has an example, the output lint prints on it, the fix, and how a deliberate finding is accepted.

## How to fix findings

1. Read the finding's message and the rule's reference.
2. Look at the sync config at the line and column the finding gives, and at the migrations for the tables and policies it names.
3. Make the smallest change that ties the rows to the user who receives them: filter by `auth.user_id()` (or `request.user_id()` in sync rules), go through a membership table the user's own rows pick, list only the columns the app needs, or enable RLS with the policies the app needs in a new migration.
4. Run lint again and check the finding is gone and no new one appeared.

Keep the app working. A fix that drops rows the app needs is not a fix; if the only way to quiet a finding breaks a feature, ask the user.

## What you must not do without the user

Never do these without the user's explicit say-so, given for this finding:

- accept a finding with `--allow`, or add `--allow` to a hook command, a CI workflow, a package script or any other place lint runs;
- weaken, widen or delete an RLS policy, a grant or a filter in the sync config to make a finding go away;
- disable RLS on a table, or mark a column `samesight:not-personal`, to quiet lint.

When a finding looks deliberate (a table public by design, a column a team really shares), explain the finding to the user, say what accepting it would mean, and ask. The rule's reference shows how a finding is accepted once the user agrees.

If the same finding comes back after two attempts to fix it, stop. Tell the user what you tried and what lint still reports, and ask how to go on instead of trying again.

## What a clean lint does not prove

Lint flags known mistakes. A clean lint is not proof that no rows leak.

`npx samesight audit` tests what lint cannot: it runs the project's own RLS against its own sync config on the local Supabase stack, with generated data, real users and headless devices, and compares the rows each device receives with the rows RLS returns its user. It needs Docker, a running local stack (`supabase start`) and the `@samesight/verify` package. It takes minutes and starts containers, so run it only when the user asks for it.

## Who receives which columns

```bash
npx samesight exposure
```

prints, for each table the sync config sends, who receives its rows and which columns, marking those that likely hold personal data. It takes the same file and `--migrations` arguments as lint, reads files only, and always exits 0 when it runs. Use it to answer "who gets this column?" before and after a change.

## More

- Every option of lint: https://rayanyedaly.github.io/samesight/cli#lint
- The rule pages, with what each rule catches and what audit does with it: https://rayanyedaly.github.io/samesight/rules/

samesight and this skill are under the MIT license, copyright (c) 2026 Rayan Yedaly: https://github.com/rayanyedaly/samesight/blob/main/LICENSE
