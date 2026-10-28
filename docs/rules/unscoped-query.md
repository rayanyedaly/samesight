# unscoped-query

Level: error, or warning when fixed values or a check on who is asking (a role claim, an admin list) filter the rows.

Rows every user receives, because nothing ties them to who is asking.

## What it catches

PowerSync replicates your tables with a database role that bypasses row level security, so the sync config is the only filter between your tables and a device. RLS on a table may refuse each user most of its rows, but PowerSync never asks it. A query that nothing ties to the requesting user sends its rows to every device.

Lint reports:

- a stream query no token value limits, directly, through a CTE or through a subquery;
- a sync rules data query no bucket parameter limits: every user the bucket reaches gets every row, and a bucket with no parameter query reaches everyone;
- a sync rules parameter query whose bucket parameters, as the data queries use them, come from neither the token nor the client: it hands its buckets to every user.

A query that only a client parameter limits is [`client-scoped`](client-scoped.md)'s.

### What ties a query to the user

A token value counts only where a row is compared with it, as in `owner_id = auth.user_id()`. These do not count:

- `OR true`, `IS NOT NULL`, `NOT IN`, and an outer join's `ON`;
- the token compared with a client value, or mixed with one (`coalesce(subscription.parameter('u'), auth.user_id())`);
- a claim every signed-in Supabase user passes (`role` or `aud` = `'authenticated'`), or every non-anonymous one (`is_anonymous` = false), however cast;
- a row compared with a claim that tells no user apart (`public_to = auth.parameter('role')`, `iss`, `aal`);
- a client value checked IN a set, even the user's own: it only proves the set is not empty. Write `org_id IN (SELECT org_id FROM members WHERE user_id = auth.user_id())` instead.

A set with a `UNION`, or one that selects a client value, never counts. A set tested by the token or a literal counts only when it selects a column (`SELECT DISTINCT user_id FROM admins`), not a fixed value.

Lint does not relate the tables of a join inside a set, so `org_id IN (SELECT o.id FROM orgs o, members m WHERE m.user_id = auth.user_id())` passes it. Audit, which tests the rows, does not.

### Error or warning

It is an error when nothing filters the rows, or when the only check is one every signed-in (or non-anonymous) user passes. It warns instead when:

- a row's column is compared with a fixed value, or used alone as a flag (`status = 'public'`, `is_public`), not with a value the client picks: often data public by design;
- the rows go to whoever passes a check on who is asking, such as a role claim, `auth.user_id() IN (SELECT user_id FROM admins)`, or a literal in a set of the user's own rows (`'admin' IN (SELECT role FROM user_roles WHERE user_id = auth.user_id())`);
- a fixed check on `iss`, `aal` or `amr`, which many or all users pass, is what limits them;
- in sync rules, every parameter query of a bucket with open data gives no bucket parameters and admits only users passing a fixed check on their own row or token (`is_admin = true`).

Lint cannot tell a role from any other fixed check, so each warning says what to confirm. A warning can still be a real leak: `deleted = false` filters rows yet sends every undeleted one to everyone, and `auth.user_id() IN (SELECT id FROM profiles)` admits every user, not admins.

## Example

A notes app sends each user their notebooks, and the notes in them. The second query joins notes to notebooks, but has no clause that ties the notebook to the user:

<!-- example:unscoped-query -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  my_notes:
    auto_subscribe: true
    queries:
      - SELECT * FROM notebooks WHERE owner_id = auth.user_id()
      - SELECT notes.* FROM notes INNER JOIN notebooks ON notes.notebook_id = notebooks.id
```
<!-- /example -->

The join reads like a filter, but nothing in the query reads the requesting user, so every device receives every note.

## What lint prints

<!-- rule-lint:unscoped-query -->
```console
$ npx samesight lint sync-config.yaml
sync-config.yaml:9  error    stream my_notes, queries[1] sends every row of notes to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim  (unscoped-query)
1 error
```
<!-- /rule-lint -->

## The fix

Compare the rows with the token, here through the notebook's owner:

```yaml
      - SELECT notes.* FROM notes INNER JOIN notebooks ON notes.notebook_id = notebooks.id WHERE notebooks.owner_id = auth.user_id()
```

For rows shared through another table, compare the row with the user's own set: `WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.user_id())`.

## What audit does

Audit tests the rows. It starts PowerSync on the sync config, signs up users, gives each a device, and compares what each device holds with what RLS returns for the same user. With RLS that lets each user read only the notes in their own notebooks, every note a device holds that RLS refuses its user is reported as a `leak`, with the query that sent it and the policy that refuses it, and the run fails. Rows RLS lets every user read, such as data public by design, are no leak to audit.

[How sync configs leak](../how-sync-configs-leak.md#a-query-without-an-owner-filter) shows this pattern on PowerSync's to-do list demo, with a recorded audit run, and [a parameter query that lists every owner](../how-sync-configs-leak.md#a-parameter-query-that-lists-every-owner), the same rule on sync rules.

## Accepting it

When every user is meant to receive the rows, such as a table public by design, accept the finding by stream, bucket or table name:

```bash
npx samesight lint sync-config.yaml --allow unscoped-query:notes
```

`--allow unscoped-query` accepts every finding of the rule. See [lint](../cli.md#lint).
