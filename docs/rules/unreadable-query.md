# unreadable-query

Level: warning.

A query `samesight-verify audit` cannot attribute to one table, so it cannot check it.

## What it catches

PowerSync replicates past RLS, so a device holds whatever its queries select. Audit is the check that compares those rows with what RLS returns, table by table, so it must know which table each synced row comes from. It refuses a query it cannot attribute to one table rather than guess what devices hold. The query may be fine, but nothing checks it until it is rewritten into a shape audit reads.

Lint runs audit's own reader on every query, CTE and parameter query, and gives its reason. Audit refuses:

- `SELECT *` across a join (name the table, as in `notes.*`), or columns of more than one table;
- a column left unqualified in a join;
- a join other than `[INNER] JOIN ... ON`, such as a `LEFT JOIN`;
- a table outside `public`, or one named with its database;
- one device table name holding two tables' rows (`SELECT * FROM todos AS lists` beside `SELECT * FROM lists`), since rows of the two could not be told apart;
- SQL it cannot read safely, such as a prefixed literal (`E'...'`).

## Example

A notes app sends each user the notes in their own notebooks, with a join:

<!-- example:unreadable-query -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  my_notes:
    auto_subscribe: true
    query: SELECT * FROM notes INNER JOIN notebooks ON notes.notebook_id = notebooks.id WHERE notebooks.owner_id = auth.user_id()
```
<!-- /example -->

The query is scoped, but `SELECT *` across the join selects the columns of both tables, so audit cannot tell which table the device rows belong to.

## What lint prints

<!-- rule-lint:unreadable-query -->
```console
$ npx samesight lint sync-config.yaml
sync-config.yaml:7  warning  stream my_notes, query cannot be checked by audit: it selects * across a join; name the table, as in t.*  (unreadable-query)
1 warning
```
<!-- /rule-lint -->

## The fix

Select one table's columns, qualified:

```yaml
    query: SELECT notes.* FROM notes INNER JOIN notebooks ON notes.notebook_id = notebooks.id WHERE notebooks.owner_id = auth.user_id()
```

## What audit does

Audit fails its Sync config section on the same query, with the same reason, and stops there: it checks nothing else until the query is rewritten. The one exception is a stream that is not `auto_subscribe`, which audit skips (see [`not-auto-subscribed`](not-auto-subscribed.md)) and so does not read at all.

## Accepting it

When the query is right and you check it some other way, accept the finding by stream or bucket name. Audit still refuses the config.

```bash
npx samesight lint sync-config.yaml --allow unreadable-query:my_notes
```

`--allow unreadable-query` accepts every finding of the rule. See [lint](../cli.md#lint).
