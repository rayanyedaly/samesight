# client-scoped

Level: error, or warning beside a check on who is asking (a role claim, an admin list).

Rows picked by what the client sends, with nothing tying them to who is asking.

## What it catches

Client parameters are whatever the app passes, so whatever anyone passes: `subscription.parameter()` and `connection.parameter()` in sync streams, `request.parameters()` and `user_parameters` in sync rules. A query limited by one and by no token value lets any client ask for any rows. The app sends its own user's values, so in normal use every device gets the right rows, but a modified client can send any values and receive those rows. RLS never sees the request: PowerSync evaluates the parameter itself.

A row compared with a token value too bounds what can be asked, and makes the query fine. These do not:

- a token check in an `OR` branch beside the client value;
- a value that mixes the two, such as `coalesce(subscription.parameter('u'), auth.user_id())`;
- the client value IN the user's own set (`subscription.parameter('org') IN (SELECT org_id FROM members WHERE user_id = auth.user_id())`): it only proves the set is not empty.

A sync rules parameter query that selects a client value as a bucket parameter is reported even where the user's own rows bound it: select the column instead (`SELECT org_id FROM members WHERE ...`).

Beside a check on who is asking it warns instead: only users who pass can ask, but they can ask for any row.

## Example

A project tool syncs the tasks of the project the app names when it connects:

<!-- example:client-scoped -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  project_tasks:
    auto_subscribe: true
    query: SELECT * FROM tasks WHERE project_id = connection.parameter('project_id')
```
<!-- /example -->

## What lint prints

<!-- rule-lint:client-scoped -->
```console
$ npx samesight lint sync-config.yaml
sync-config.yaml:7  error    stream project_tasks, query picks which rows of tasks it sends by a parameter the client sends, and nothing limits them to the requesting user, so any client can ask for any of them  (client-scoped)
1 error
```
<!-- /rule-lint -->

## The fix

Keep the parameter to narrow the rows, and compare the row with the user's own memberships too, so a client can only ask for projects its user belongs to:

```yaml
    query: SELECT * FROM tasks WHERE project_id = connection.parameter('project_id') AND project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.user_id())
```

## What audit does

Audit warns, in its Sync config section, that the stream reads client parameters. The devices it runs connect with none, so it never tries what a modified client could send: lint is the check for this pattern, and a passing audit says nothing about it.

With no parameter, a query that a client parameter selects returns no rows. When no other stream sends the table either, as in the example, no device receives any of its rows, and audit fails the run: its Differential section says the datasets left the table untested, because no device received any row of it (or, when audit could not insert a row some test user may read, it names that instead). That is a run that could not check the table, not a finding that it leaks. The fixed query still reads the parameter, so audit warns about it, and fails the same way.

[How sync configs leak](../how-sync-configs-leak.md#a-client-parameter-picks-the-rows) shows the sync rules form, with `request.parameters()`, and audit's warning in full.

## Accepting it

When any client is meant to be able to ask for any of these rows, accept the finding by its stream or bucket name (or, for a stream, the table's):

```bash
npx samesight lint sync-config.yaml --allow client-scoped:project_tasks
```

`--allow client-scoped` accepts every finding of the rule. See [lint](../cli.md#lint).
