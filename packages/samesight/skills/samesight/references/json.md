# samesight lint --format json

`npx samesight lint --format json` prints one JSON object on stdout. Notes about the run (such as "no migrations found") stay on stderr. This is version 1 of the document.

## Top-level fields

| Field | What it holds |
| --- | --- |
| `$schema` | The URL of `samesight/schema/lint.schema.json` for this version. |
| `version` | `1`. |
| `tool` | `"samesight"`. |
| `toolVersion` | The samesight version that ran. |
| `files` | The sync configs lint read. |
| `rlsChecked` | Whether migrations were read, so `rls-off` and `rls-open` ran. |
| `findings` | The findings that count, as below. |
| `allowed` | The findings `--allow` accepted, in the same shape. They do not count toward the exit code. |
| `unreadable` | Files lint could not read, each `{ "file": ..., "error": ... }`. |
| `errors`, `warnings`, `notes` | How many kept findings (those in `findings`) have each level. |
| `exitCode` | `0` clean or only warnings and notes, `1` an error-level finding, `2` lint could not run or a file could not be read. |
| `error` | A string, present only when lint could not run: no sync config found, a bad `--migrations` directory, an unknown `--allow` rule, a bad flag. |

## A finding

| Field | What it holds |
| --- | --- |
| `rule` | The rule's id, such as `unscoped-query`. How to fix it is in `<rule>.md`, beside this file. |
| `level` | `error`, `warning` or `info`. |
| `file` | The sync config the finding is in. |
| `line`, `column` | Where in that file, 1-based. Absent when the finding is about the whole file. |
| `message` | What is wrong, in one sentence. |
| `subjects` | The names the finding is about: the stream or bucket, table, policy or column. `--allow <rule>:<name>` matches one of these. |

Read `exitCode` and `error` first: when lint could not run, `findings` is empty and proves nothing.
