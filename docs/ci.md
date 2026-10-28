# CI and the GitHub Action

Samesight ships a GitHub Action at the root of its repository, `rayanyedaly/samesight`. It runs in one of two modes:

- **`lint`** runs `samesight lint` on your sync config and SQL migrations. It catches known leak patterns, such as a stream query no token value limits, in seconds. It needs no database, no Docker and no policy file. Findings show as annotations on the pull request, and as code scanning alerts if you upload the SARIF file.
- **`audit`** runs `samesight-verify audit`. It starts the project's local Supabase stack, starts its own PowerSync service, and compares what each device receives with what RLS returns for the same user. It tests the rows themselves, so it catches what lint cannot. It needs a runner with Docker and takes several minutes.

A common setup is lint on every pull request and audit on pull requests that change the sync config or the migrations.

> Samesight is not released on npm until 0.1.0 (the `samesight` name holds a 0.0.0 placeholder with no command). Until then the action has nothing to install. By default it installs the version in its own `packages/samesight/package.json`: at a release tag (`@v0.1.0`) that is the release itself; at a branch or commit SHA it is whatever that file names, which may be older than the action or not published yet. The examples below name `0.1.0`, the first release.

## Lint with annotations

This needs no special permissions. Findings show on the pull request's changed lines, and the step fails on an error-level finding.

```yaml
# .github/workflows/samesight-lint.yml
name: Samesight lint

on:
  pull_request:

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: rayanyedaly/samesight@v0.1.0
        with:
          mode: lint
          sync-config: powersync/sync-config.yaml
          version: 0.1.0
```

Lint reads the migrations under `<project>/supabase/migrations` for the RLS rules (`rls-off`, `rls-open`). Set `project` when `supabase/` is not at the repository root.

## Lint with SARIF upload

With `upload-sarif: true`, the action also uploads the SARIF file to GitHub code scanning with `github/codeql-action/upload-sarif@v4`. Findings then show as alerts in the repository's Security tab, and on a pull request when the alert's lines are in its diff.

```yaml
# .github/workflows/samesight-lint.yml
name: Samesight lint

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  actions: read # private repositories only
  security-events: write

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: rayanyedaly/samesight@v0.1.0
        with:
          mode: lint
          sync-config: powersync/sync-config.yaml
          version: 0.1.0
          upload-sarif: true
```

The upload needs `security-events: write`. On a private repository it also needs `actions: read` and `contents: read`, and GitHub Code Security or Advanced Security turned on for the repository. Annotations are written either way.

Running on pushes to `main` as well gives code scanning a baseline, so it can tell which alerts a pull request adds.

## Audit on pull requests that change access

Audit starts containers, so run it only when the sync config or the migrations change. Use a `paths:` filter:

```yaml
# .github/workflows/samesight-audit.yml
name: Samesight audit

on:
  pull_request:
    paths:
      - powersync/sync-config.yaml
      - supabase/migrations/**
      - supabase/config.toml

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
      - uses: rayanyedaly/samesight@v0.1.0
        with:
          mode: audit
          sync-config: powersync/sync-config.yaml
          version: 0.1.0
```

In audit mode the action:

1. installs the Supabase CLI;
2. runs `supabase start` in `project` (or uses the stack when one is already running there, and leaves it running), starting only Postgres, Auth, REST and the gateway (`exclude` lists the services it leaves out);
3. runs `samesight-verify audit`, which starts its own PowerSync service in Docker and removes it at the end;
4. adds the Markdown report to the job summary;
5. stops Supabase if it started it, whether the audit passed or not.

The job summary can be read by anyone who can read the workflow run. The report holds the run's generated rows, its flags and local paths; see [`--report`](verify.md#options).

Besides the report, the action changes the job it runs in. Without `version: installed` it sets up Node `node-version` for the steps after it, and puts the commands it installs first on the PATH: `samesight` in lint mode, `samesight-verify`, `samesight` and `supabase` in audit mode (`supabase` also with `version: installed`, when none is on the PATH). In audit mode, when `config.toml` names a `signing_keys_path` file that is missing, empty or `[]`, it writes a new local signing key there (in your checkout, unless the path is absolute); and when it started Supabase, it stops it with `--no-backup`, which deletes the stack's data.

The verifier refuses to run where `NODE_ENV` is set to anything but `development` or `test`, or where variables a hosting platform sets (`VERCEL`, `FLY_APP_NAME` and others) are present. Do not set them in this job.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `mode` | (required) | `lint` or `audit`. |
| `sync-config` | `sync-config.yaml` | The PowerSync sync config, sync streams or sync rules, relative to the repository root. Check the repository out at the workspace root (no `path:`), so annotations and code scanning land on the right file. |
| `project` | `.` | The directory holding `supabase/`, relative to the repository root. |
| `version` | this action's own version | The npm version of `samesight` (lint) or `@samesight/verify` (audit) to install: by default the version in the action's `packages/samesight/package.json`, the release itself at a release tag. `installed` uses the CLIs already on the PATH. |
| `node-version` | `22` | The Node version to set up, unless `version` is `installed`. Samesight needs 22.18 or newer. |
| `upload-sarif` | `false` | Lint mode: upload the SARIF file to code scanning. |
| `sarif-category` | `samesight` | Lint mode: the code scanning category of the upload. Give each job its own when one repository lints more than one sync config. |
| `args` | | Extra flags for `samesight lint` or `samesight-verify audit`, such as `--allow unscoped-query:customers` or `--runs 4 --seed 7`, split on spaces and newlines (no quoting). |
| `supabase-version` | `2.122.0` | Audit mode: the Supabase CLI version to install from npm. |
| `exclude` | every service but Postgres, Auth, REST and the gateway | Audit mode: the Supabase services `supabase start` does not start (its `-x` list). |

With `version: installed`, install the packages yourself and put their binaries on the PATH first. The versions then come from your lockfile:

```yaml
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
      - run: echo "$PWD/node_modules/.bin" >> "$GITHUB_PATH"
      - uses: rayanyedaly/samesight@v0.1.0
        with:
          mode: lint
          sync-config: powersync/sync-config.yaml
          version: installed
```

## Outputs

| Output | |
| --- | --- |
| `exit-code` | The exit code of `samesight lint` or `samesight-verify audit`: 0, 1 or 2, or another code when the command did not start. |
| `sarif-file` | Lint mode: the path of the SARIF file. |
| `annotations-file` | Lint mode: the path of a file holding the annotations the run printed. |
| `report-file` | Audit mode: the path of the Markdown report. |

## Pinning

Pin the action to a release tag or, stricter, to a full commit SHA, and pin `version` to an exact version, the same one:

```yaml
      - uses: rayanyedaly/samesight@<full commit SHA> # v0.1.0
        with:
          mode: lint
          version: 0.1.0
```

The actions it uses itself, `actions/setup-node` and `github/codeql-action/upload-sarif`, are pinned to commit SHAs in `action.yml`. An exact `version` pins `samesight` and `@samesight/verify`, not every package they depend on, since the action installs them without a lockfile; for that, use `version: installed` with your own lockfile.

`version: latest` installs whatever npm has on the day of the run, so a new release can change your results, or fail a run that passed, with no change in your repository. Before 1.0, a minor version may change what lint and audit report; the [changelog](../CHANGELOG.md) lists each change.

## When a run fails

Both modes exit with the same codes, and the step fails on 1 or 2:

| Exit code | Meaning |
| --- | --- |
| `0` | Passed. Lint warnings and notes do not fail a run. |
| `1` | Lint found an error-level finding, or audit found a leak or another failing check. |
| `2` | The run could not do its job: a file it could not find, a flag it could not read, or, in audit mode, a database or service it could not reach. |

A failing lint run shows each finding as an annotation (errors, warnings and notes) on the pull request's changed lines, and the full text output in the step's log. GitHub limits how many annotations a step shows, so the log and the SARIF file are the complete list.

A failing audit run prints the findings in the step's log and puts the Markdown report in the job summary: for each row a device got that RLS refuses, who received it, the stream and query that sent it, the policies that decided, the likely fix and the command that replays the run locally.

To run later steps whatever the result, use `continue-on-error`, then fail the job at the end. Later steps can read `exit-code` to tell a finding (1) from a run that could not do its job (2):

```yaml
      - id: samesight
        uses: rayanyedaly/samesight@v0.1.0
        continue-on-error: true
        with:
          mode: lint
          sync-config: powersync/sync-config.yaml
          version: 0.1.0
      # ... steps that should run either way ...
      - if: steps.samesight.outcome == 'failure'
        run: exit 1
```

A finding that is deliberate, such as a table public by design, can be accepted with `args: --allow <rule>:<name>`; see [lint](cli.md#lint).

## Troubleshooting

**Audit fails because Docker is missing.** Audit mode needs a Linux runner with Docker: `ubuntu-latest`, or a self-hosted Linux runner with Docker installed. GitHub's macOS and Windows runners cannot run the Supabase containers. Lint mode runs on any runner.

**Audit fails because there is no `supabase/config.toml`.** `supabase start` needs a Supabase CLI project. Set `project` to the directory that holds `supabase/config.toml` and `supabase/migrations`. A project that has none can create it with `supabase init` and commit it, with its migrations under `supabase/migrations`.

**The SARIF upload fails on a private repository.** Code scanning on a private repository needs GitHub Code Security or Advanced Security, and the job needs `security-events: write`, `actions: read` and `contents: read`. Without them, leave `upload-sarif` at `false`: the annotations still show on the pull request, and the SARIF file is still written (its path is the `sarif-file` output), so you can keep it with `actions/upload-artifact`.

**An alert does not show on the pull request.** Code scanning shows an alert on a pull request only when its lines are in the diff. The alert is still listed in the Security tab.

**The install step fails.** `version` must name a version published on npm. Before the first release there is none, so the install step fails and says so.
