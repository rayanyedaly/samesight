# not-auto-subscribed

Level: info.

A stream devices get only when the app subscribes, which audit does not test.

## What it catches

A sync stream without `auto_subscribe: true` reaches a device only when the app subscribes to it, with parameters the app chooses. Nothing is wrong with that in itself: on-demand streams keep devices from downloading what they do not need. But audit does not subscribe to it, so it does not test it, and what reaches a device depends on what the app, or anyone calling the API, asks for. RLS does not narrow a subscription either: PowerSync sends what the stream's query selects for the parameters it is given.

Sync rules buckets always sync, so the rule applies to sync streams only.

## Example

A notes app loads one notebook's notes when the user opens it:

<!-- example:not-auto-subscribed -->
`sync-config.yaml`:

```yaml
config:
  edition: 3

streams:
  notebook_notes:
    query: SELECT * FROM notes WHERE notebook_id = subscription.parameter('notebook_id') AND owner_id = auth.user_id()
```
<!-- /example -->

The query compares each row with the token (`owner_id = auth.user_id()`), so whatever notebook a client names, it gets only its own user's notes, and lint's other rules pass it. The note only says audit does not test it.

## What lint prints

<!-- rule-lint:not-auto-subscribed -->
```console
$ npx samesight lint sync-config.yaml
sync-config.yaml:6  info     stream notebook_notes is not auto_subscribe: devices get its rows only when the app subscribes, with the parameters it sends, and audit does not test it  (not-auto-subscribed)
1 note
```
<!-- /rule-lint -->

## The fix

Nothing, when on demand is the design: keep each query tied to the token, as here, so a subscription can only ask for its user's rows, and accept the note (below). When every device should hold the rows, subscribe them all, and audit tests the stream:

```yaml
streams:
  my_notes:
    auto_subscribe: true
    query: SELECT * FROM notes WHERE owner_id = auth.user_id()
```

## What audit does

Audit skips the stream with a warning in its Sync config section: no device it runs subscribes to it, so its rows are not compared with RLS. Here it also warns that the stream reads a client parameter. When no stream is left to compare, that section fails. Lint's other rules still read the stream's queries, so lint is the only check on them.

## Accepting it

Accept the note by stream name, or every on-demand stream with the rule alone:

```bash
npx samesight lint sync-config.yaml --allow not-auto-subscribed:notebook_notes
npx samesight lint sync-config.yaml --allow not-auto-subscribed
```

See [lint](../cli.md#lint).
