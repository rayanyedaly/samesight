# Lint rules

`samesight lint` reads a PowerSync sync config, and the project's SQL migrations when it has them, and reports these patterns. Each rule's page shows an example, what lint prints on it, the fix, and what `samesight-verify audit` does with it.

| Rule | Level | What it catches |
| --- | --- | --- |
| [`unscoped-query`](unscoped-query.md) | error, or warning | Rows every user receives, because nothing ties them to who is asking. |
| [`client-scoped`](client-scoped.md) | error, or warning | Rows picked by what the client sends, with nothing tying them to who is asking. |
| [`user-metadata`](user-metadata.md) | error | Access decided by the token's `user_metadata`, which every user can set on themselves. |
| [`unreadable-query`](unreadable-query.md) | warning | A query `samesight-verify audit` cannot attribute to one table, so it cannot check it. |
| [`not-auto-subscribed`](not-auto-subscribed.md) | info | A stream devices get only when the app subscribes, which audit does not test. |
| [`rls-off`](rls-off.md) | warning | A synced table whose migrations never enable row level security. |
| [`rls-open`](rls-open.md) | warning | A policy on a synced table that lets any client or any signed-in user through. |

An error fails the run (exit code 1). Warnings and notes do not, but each warning needs a decision: fix it, or accept it. `rls-off` and `rls-open` run only when lint has migrations to read, from `supabase/migrations` or the directory `--migrations` names.

A finding that is deliberate, such as a table public by design, can be accepted with `--allow <rule>:<name>` (a stream, bucket, table or policy name) or `--allow <rule>` (every finding of the rule). Allowed findings are counted in the output, never dropped silently, and a misspelt rule name is an error. See [lint](../cli.md#lint) for every option.

Lint proves nothing about what reaches a device: it flags known mistakes in seconds. [`samesight-verify audit`](../verify.md#audit-mode) tests the rows.
