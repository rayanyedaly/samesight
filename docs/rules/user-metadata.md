# user-metadata

Level: error.

Access decided by the token's `user_metadata`, which every user can set on themselves.

## What it catches

Supabase puts two metadata objects in the token. `app_metadata` only the server can set. `user_metadata` every signed-in user can change for themselves, with `supabase.auth.updateUser({ data: { ... } })`. The token is verified, so the claim looks trustworthy, but its value is whatever the user last wrote: whatever access it grants, anyone can grant themselves.

Lint reports a read of it from the token (`auth.parameter('user_metadata')`, a path into it such as `auth.parameter('user_metadata.team_id')`, `auth.parameters() -> 'user_metadata'`, `request.jwt() -> 'user_metadata'`, or a `'$.user_metadata'` JSON path) anywhere in a stream CTE or a sync rules parameter query, and in the conditions (`WHERE`, `JOIN ... ON`) of a query whose rows are synced. Selecting it into synced rows decides nothing, and passes.

RLS that reads the same claim has the same hole. RLS that reads a memberships table does not, but PowerSync replicates past RLS and never asks it.

## Example

A team workspace sends each user their team's documents, with the team read from `user_metadata`:

<!-- example:user-metadata -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  team_documents:
    auto_subscribe: true
    query: SELECT * FROM documents WHERE team_id = auth.parameter('user_metadata') ->> 'team_id'
```
<!-- /example -->

Any user can set `team_id` to another team's id and, with their next token, receive that team's documents.

## What lint prints

<!-- rule-lint:user-metadata -->
```console
$ npx samesight lint sync-config.yaml
sync-config.yaml:7  error    stream team_documents, query decides access from user_metadata, which every Supabase user can set on themselves (supabase.auth.updateUser); use app_metadata or a table  (user-metadata)
1 error
```
<!-- /rule-lint -->

## The fix

Decide access from a table the user cannot write:

```yaml
    query: SELECT * FROM documents WHERE team_id IN (SELECT team_id FROM team_members WHERE user_id = auth.user_id())
```

Or from `app_metadata`, set from the server or an access token hook: `WHERE team_id = auth.parameter('app_metadata') ->> 'team_id'`.

## What audit does

Audit fails the run in its Database catalog section on any RLS policy or stream query that reads `user_metadata`, and skips the differential until it is fixed. Its check is wider than lint's: a stream query that only selects `user_metadata` fails it too.

[How sync configs leak](../how-sync-configs-leak.md) shows this pattern on PowerSync's Nuxt demo, with audit's output, under "Access decided by `user_metadata`".

## Accepting it

Whatever the claim decides, every user can decide for themselves, so accept it only where that is harmless, such as a preference that only narrows rows the token already allows. Audit fails such a query all the same. Accept it by stream or bucket name:

```bash
npx samesight lint sync-config.yaml --allow user-metadata:team_documents
```

`--allow user-metadata` accepts every finding of the rule. See [lint](../cli.md#lint).
