# Coding agents

Coding agents now write sync configs and migrations, and they do not know what your RLS allows. One missing filter in a stream query sends every user's rows to every device, and nothing fails. Samesight can run inside the agent's loop: after each edit to a sync config or a migration, lint runs and the agent reads what it found and fixes it before going on.

It has two parts, both shipped in the `samesight` package:

- **A post-edit hook**, `samesight agent hook`. Claude Code and Codex run it after the agent edits a file. When the edit touched a sync config or a migration, it lints the sync configs; a leak blocks the agent until it is fixed.
- **A skill**, in the [Agent Skills](https://agentskills.io) format: when to run lint, how to read its findings, how to fix each rule, and what not to change without you (accepting a finding, weakening RLS).

## Setting it up

```bash
npm install -D samesight
npx samesight agent init
```

`agent init` writes:

| File | For |
| --- | --- |
| `.claude/skills/samesight/` | The skill, for Claude Code |
| `.agents/skills/samesight/` | The skill, for Codex and other agents that read `.agents/skills` |
| `.cursor/skills/samesight/` | The skill, for Cursor |
| `.claude/settings.json` | The hook, for Claude Code (and Cursor, which runs Claude Code's hooks) |
| `.codex/hooks.json` | The hook, for Codex |

It only adds. Other hooks and settings in those files are kept. A hook that already runs `samesight agent hook` is left as it is. A settings file it cannot read (comments in JSON, say) is left alone, and it prints the entry to add by hand and exits 2. A second run writes nothing, so it is safe to run again after updating samesight: it brings the skill up to date. Rewriting a settings file can change its formatting, though never its content.

```bash
npx samesight agent init --print            # say what it would write, write nothing
npx samesight agent init --agents claude    # only Claude Code (claude, codex, cursor)
```

Commit the files, so every agent working on the project runs the hook. Codex asks you to review and trust a new hook first: run `/hooks` in Codex.

The hook command is `npx --no-install samesight agent hook`, which uses the project's own samesight and never downloads one (`yarn samesight agent hook` under Yarn Plug'n'Play). So samesight must be installed in the project, at its root in a monorepo, or run `agent init` from the package that has it.

## Where your files are

The hook finds the sync config and the migrations where lint does: `sync-config.yaml` or `sync-rules.yaml`, here or under `powersync/`, and `supabase/migrations`. Name them otherwise, and accept findings, as you would for lint; `agent init` puts the arguments in the hook command:

```bash
npx samesight agent init app/powersync/sync.yaml --migrations db/migrations --allow unscoped-query:public_posts
```

To change them later, run `agent init` again with the new arguments after removing the old hook entry, or edit the command in the settings files.

## What the hook does

It reads the edit from the hook's JSON on stdin and lints only when the edit touched:

- the sync config it lints (named, or found as above);
- a `.sql` file directly in the migrations directory;
- another YAML file with `streams` or `bucket_definitions` at its top level, which it lints too.

Any other edit, a project with no sync config, or another hook event gets no output and costs about a third of a second, most of it `npx` starting. PowerSync's `service.yaml` does not count.

What the agent sees:

- **An error finding, or a sync config lint cannot read**: the hook exits 2, with each finding (file, line, column, rule, message), where to read the fix (the skill's reference for the rule, and its page here), and "fix the errors above before going on; if a finding is intended, ask the user before accepting it with --allow". Claude Code and Codex hand this to the agent, which goes on to fix it. The edit itself has already been made.
- **Warnings and notes only**: they are passed as context, and do not block. The skill tells the agent to decide them with you.
- **Nothing found**: one line of context, which says lint reads files only and a clean lint does not show that no rows leak. [Audit](verify.md#audit-mode) tests that, on the local stack, when you run it.
- **No migrations read**: the context says the RLS rules (`rls-off`, `rls-open`) did not run.
- **An installed skill that differs from the package's**: one line saying `agent init` updates it.

A problem of the hook's own (a payload it cannot read, a `--migrations` directory that is not there) never blocks the agent: it exits 0, with a note.

An agent that cannot fix a finding is blocked on each edit to those files. The skill tells it to stop after two tries and ask you.

## Agents

- **Claude Code** runs the hook after `Write`, `Edit` and `MultiEdit`, from `.claude/settings.json`, and reads the skill from `.claude/skills`.
- **Codex** runs it from `.codex/hooks.json` after `apply_patch`, `Edit` and `Write` once you have trusted it, and reads the skill from `.agents/skills`. The hook reads the files an `apply_patch` names. It follows Codex's documented hook format and has not been tested against a running Codex yet; if your Codex edits files another way, the hook still lints when the command names the sync config or the migrations directory.
- **Cursor** runs Claude Code's hooks from `.claude/settings.json` when its third-party hooks setting is on (the default), and reads the skill from `.cursor/skills`. Cursor's support for them has had bugs in some versions. When no hook output arrives, the skill tells the agent to run `npx samesight lint --format json` itself.
- **Other agents** that read `.agents/skills` (GitHub Copilot, Windsurf and Cline document it) get the skill, which tells them to run lint after each such edit, but not the hook.

## Removing it

Delete the `samesight` entry from `hooks.PostToolUse` in `.claude/settings.json` and `.codex/hooks.json`, and the `samesight` directories under `.claude/skills`, `.agents/skills` and `.cursor/skills`.

## Lint's JSON

The skill tells agents to run `npx samesight lint --format json`. The document is versioned and has a published schema, `samesight/schema/lint.schema.json`; it is printed on every exit, with `error` saying why when lint could not run. See [lint](cli.md#lint).
