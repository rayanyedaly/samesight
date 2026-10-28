# How sync configs leak

PowerSync replicates your tables with a database role that bypasses row level security, so RLS never filters what it reads. The sync config is the only filter between your tables and a device. When the sync config is wider than your RLS, nothing fails: queries still run, the app still works, and a device just holds rows its user may not read. The user, or anyone holding the device, can read them in the app's local database.

This page shows four ways that happens. Each comes from [`corpus/planted/`](../corpus/planted): a sync config from one of PowerSync's public demos with one line changed, as [`corpus/SOURCES.md`](../corpus/SOURCES.md) records. Every one of them passes PowerSync's own validator, which warns about only one of them (the client parameter), so each is a config PowerSync would deploy.

For each pattern you see the changed lines, why RLS does not stop it, what `samesight lint` prints (generated from the corpus by `scripts/docs/leaks.mjs`), and what `samesight-verify audit` says. Where audit's answer needs no database, the block shows what audit prints before it reads one, computed by audit's own code; the rest comes from a recorded run. `scripts/docs/leaks.mjs` keeps every block in step.

## A query without an owner filter

PowerSync's to-do list demo sends each user their own lists, and the to-dos in them:

```yaml
streams:
  user_data:
    auto_subscribe: true
    queries:
      - SELECT * FROM lists WHERE owner_id = auth.user_id()
      - SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()
```

In the planted copy, the second query lost its last clause:

```yaml
      - SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id
```

The join still reads like a filter, but nothing in the query reads the requesting user, so every device receives every to-do. RLS on `todos` is not consulted: the stream query is all PowerSync runs.

<!-- lint:missing-owner-filter -->
```console
$ npx samesight lint corpus/planted/missing-owner-filter.yaml
corpus/planted/missing-owner-filter.yaml:14  error    stream user_data, queries[1] sends every row of todos to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim  (unscoped-query)
1 error
```
<!-- /lint -->

Lint flags a query that reads nothing from the user's token. It does not compare the query with your RLS; audit does. [`examples/audit-todolist`](../examples/audit-todolist) plants the same mistake on the demo's other query (`SELECT * FROM lists WHERE owner_id = auth.user_id()` becomes `SELECT * FROM lists`) and runs audit on it. Audit starts PowerSync on the planted config, signs up users, gives each a device, and compares what each device holds with what RLS returns for the same user. Every list a device holds that RLS refuses its user is a leak, reported like this. This is an excerpt of [a recorded run](assets/audit-demo.txt), with row ids shortened:

<!-- capture:audit-demo -->
```text
FAIL  differential: devices and RLS disagree (seed 1842, shrunk 6 times to 3 rows; shrinking stopped at the time limit):
    leak: u1 received lists 5a3e5a3e-c272… (owner_id u0); RLS returns no such row for this user
      sent by    stream user_data, queries[0]
                 SELECT * FROM lists
      refused by policy "owned lists" on lists
      likely fix queries[0] has no owner_id filter, which policy "owned lists" has; add
                 WHERE owner_id = auth.user_id()
    (2 more row blocks, for u2 and u3, left out of this capture)
      replay     samesight-verify audit --project upstream --sync-config upstream/sync-config.planted.yaml --runs 3 --time-limit 60 --seed 1842
```
<!-- /capture -->

The block names the query that sent the row and the policy that refuses it. Audit suggests a fix only in a narrow case: one stream query with no join, OR, subquery or CTE, and one policy that is just `column = auth.uid()`. The planted `todos` query in the corpus has a join, so for its leaks audit would name the query and the policy but suggest no fix. The `replay` line reruns the same datasets. Shrinking stops at the time limit, so a replay can shrink a different number of times and end on other rows.

## A parameter query that lists every owner

Sync rules (`bucket_definitions`) split a rule in two: a parameter query picks which buckets a user gets, and the data queries fill each bucket. PowerSync's multi-client demo gives each user one bucket, keyed by their own id. In the planted copy, the parameter query lists every owner instead:

```yaml
bucket_definitions:
  user_lists:
    parameters: SELECT user_id FROM pebbles
    data:
      - SELECT * FROM pebbles WHERE user_id = bucket.user_id
```

The data query looks scoped: it filters by `bucket.user_id`. But the parameter query returns every `user_id` in the table, so each device gets one bucket per owner, and with them every pebble. The original was `SELECT request.user_id() as user_id`. RLS cannot help: PowerSync runs both queries itself.

<!-- lint:unbound-parameter-query -->
```console
$ npx samesight lint corpus/planted/unbound-parameter-query.yaml
corpus/planted/unbound-parameter-query.yaml:8  error    bucket user_lists, parameters[0] reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists  (unscoped-query)
1 error
```
<!-- /lint -->

Audit reads a parameter query like a stream's CTE and has no warning for this one: the config reads as an ordinary bucket definition. Its differential is what finds it. With RLS that lets each user read only their own pebbles, a device holding another user's pebble is reported as a `leak`, with the bucket definition that sent it and the policy that refuses it. Audit suggests fixes for sync streams only, so this block has no `likely fix`.

## A client parameter picks the rows

PowerSync's Nuxt demo, in its sync rules form, keys each user's bucket on `request.user_id()`, which PowerSync takes from the verified token. The planted copy takes it from `request.parameters()`, which the client sends:

```yaml
bucket_definitions:
  tasks:
    parameters:
      - SELECT request.parameters() ->> 'user_id' AS user_id
    data:
      - SELECT * FROM tasks WHERE tasks.user_id = bucket.user_id
```

The app sends its own user's id, so in normal use every device gets the right tasks. A modified client can send any user's id and receive their tasks. RLS never sees the request. The same goes for `subscription.parameter()` and `connection.parameter()` in sync streams, and `user_parameters` in older sync rules.

<!-- lint:client-parameter-scope -->
```console
$ npx samesight lint corpus/planted/client-parameter-scope.yaml
corpus/planted/client-parameter-scope.yaml:14  error    bucket tasks, parameters[0] takes its bucket parameters from what the client sends, and nothing limits them to the requesting user, so any client can ask for any bucket  (client-scoped)
1 error
```
<!-- /lint -->

Audit only warns here, in its Sync config section:

<!-- audit:client-parameter-scope -->
```text
Sync config
ok    sync rules: 1 bucket definition, 1 query, sending tasks
warn  sync config: tasks reads client parameters (connection.parameter(), subscription.parameter(), request.parameters() or user_parameters), which the client chooses; devices here send none, so the run does not try what a client could ask for. Never let client parameters decide access.
```
<!-- /audit -->

The devices audit runs connect with no client parameters, and audit does not try what a modified client could send. So a passing audit says nothing about this pattern. Lint is the check for it. The fix is to take the user from the token, `request.user_id()` here, and let a client parameter only narrow rows the token already allows.

## Access decided by `user_metadata`

Supabase puts two metadata objects in the token. `app_metadata` only the server can set. `user_metadata` every signed-in user can change for themselves, with `supabase.auth.updateUser({ data: { ... } })`. The Nuxt demo's sync streams send each user the tasks whose `user_id` is theirs. The planted copy scopes tasks by a team id read from `user_metadata` instead:

```yaml
streams:
  user_tasks:
    auto_subscribe: true
    queries:
      - SELECT * FROM tasks WHERE team_id = auth.parameter('user_metadata') ->> 'team_id'
```

The token is verified, so the claim looks trustworthy, but its value is whatever the user last wrote. Any user can set `team_id` to another team's id and, with their next token, receive that team's tasks. RLS that reads the same claim has the same hole; RLS that reads a memberships table does not, but PowerSync never asks it.

<!-- lint:user-metadata-scope -->
```console
$ npx samesight lint corpus/planted/user-metadata-scope.yaml
corpus/planted/user-metadata-scope.yaml:13  error    stream user_tasks, queries[0] decides access from user_metadata, which every Supabase user can set on themselves (supabase.auth.updateUser); use app_metadata or a table  (user-metadata)
1 error
```
<!-- /lint -->

Audit fails the run in its Database catalog section on any RLS policy or stream query that reads `user_metadata`, and skips the differential until it is fixed:

<!-- audit:user-metadata-scope -->
```text
Sync config
ok    streams: 1 stream, 1 query, sending tasks

Database catalog
(the lines that read the database are left out here)
FAIL  user metadata: user_tasks.queries[0] reads user_metadata, which every user can set on themselves; decide access from app_metadata or a table instead
```
<!-- /audit -->

Decide access from `app_metadata` (set it from the server or an access token hook) or from a table the user cannot write.

## Check your own config

Lint reads files only, so it runs anywhere, in seconds. Point it at your sync config and your migrations, so the RLS rules (`rls-off`, `rls-open`) run too:

```bash
npx samesight lint powersync/sync-config.yaml --migrations supabase/migrations
```

Lint knows the patterns above and a few more, but it cannot prove a config is safe. Audit tests the rows. With your local Supabase stack running (`npx supabase start`) and Docker, it starts its own PowerSync service on your sync config and compares every device with RLS:

```bash
npm install -D samesight @samesight/verify
npx samesight audit --sync-config powersync/sync-config.yaml
```

`samesight audit` runs `samesight-verify audit` from `@samesight/verify`. Audit only ever runs against a stack on your own machine.

In GitHub Actions, the [Samesight action](ci.md) runs lint on every pull request, with annotations on the changed lines, and audit where you want it.

See [the CLIs](cli.md) for every lint rule and option, and [the verifier](verify.md) for what audit checks and what it does to your local stack.
