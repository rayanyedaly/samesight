# Coding agents

Coding agents now write sync configs and migrations, and they do not know what your RLS allows. One missing filter in a stream query sends every user's rows to every device, and nothing fails. Samesight can run inside the agent's loop: after the agent edits a sync config or a migration, lint runs, and what it found goes back to the agent while it is still working.

It has two parts, both shipped in the `samesight` package:

- **A post-edit hook**, `samesight agent hook`. Claude Code and Codex run it after the agent edits a file with their file tools. When the edit touched a sync config or a migration, it lints the sync configs, and a leak comes back to the agent as an error to fix.
- **A skill**, in the [Agent Skills](https://agentskills.io) format: when to run lint, how to read its findings, how to fix each rule, and what not to change without you (accepting a finding, weakening RLS).

It catches honest mistakes. It is not a boundary against an agent working against you: an agent can edit files with a shell command the hook never sees, or carry on after the hook reports a leak.

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

It never removes a file or changes a setting of yours. The hook is added beside your other hooks; a hook that already runs `samesight agent hook` is left as it is. A settings file it cannot read (JSON with comments, say) is left alone: it prints the entry to add by hand and exits 2. The skill directories are samesight's own: their files are added, or replaced when they differ from the installed samesight's, and files you add there are kept. Run it again after updating samesight to bring the skill up to date; when nothing differs, it writes nothing. Adding the hook rewrites a settings file in full, which keeps every setting but can change its formatting.

```bash
npx samesight agent init --print            # say what it would write, write nothing
npx samesight agent init --agents claude    # only Claude Code (claude, codex, cursor)
```

It refuses to write through a symlink or a hard link that leads out of the project, and refuses hook arguments the command could not carry safely in every shell: they may hold only ASCII letters and digits, spaces and `_+:./-`, and may not start with `-`.

Commit the files, so every agent working on the project runs the hook. Codex asks you to review and trust a new hook first: run `/hooks` in Codex.

The hook command is `npx --no-install samesight agent hook` (`yarn samesight agent hook` under Yarn Plug'n'Play). npx runs the samesight it finds, the project's first, then a parent folder's or a global one, and never installs one; with none of those it asks the registry first, which is slower. So install samesight in the project (at its root in a monorepo, or run `agent init` from the package that has it), and keep it installed for everyone who works on it:

- With no samesight to run, npx exits 1. Claude Code shows that to you as a hook error, not to the agent, and nothing is checked.
- samesight 0.1.0, from before `agent hook`, answers `unknown command "agent"` with exit 2 on each edit, which reaches the agent as an error. Update it.

## Where your files are

The hook finds the sync config and the migrations where lint does: `sync-config.yaml` or `sync-rules.yaml`, here or under `powersync/`, and `supabase/migrations`. Name them otherwise, and accept findings, as you would for lint; `agent init` puts the arguments in the hook command:

```bash
npx samesight agent init app/powersync/sync.yaml --migrations db/migrations --allow unscoped-query:public_posts
```

To change them later, remove the samesight entry from the settings files and run `agent init` again with the new arguments, or edit the command there.

## What the hook does

It reads the edit from the hook's JSON on stdin and lints only when the edit touched:

- the sync config it lints (named, or found as above);
- a `.sql` file directly in the migrations directory;
- another YAML file whose top level holds a `streams` or `bucket_definitions` mapping, which it lints too.

It lints the whole sync config each time, so a migration edit also reports errors that were there before it. Any other edit, a project with no sync config, or another hook event gets no output; the hook still starts, which takes about a third of a second through `npx`. PowerSync's `service.yaml` does not count.

What the agent sees:

- **An error finding, or a sync config lint cannot read**: the hook exits 2. Its message lists each finding (file, line, column, level, rule, message) with where to read the fix (the skill's reference for the rule, and its page here), and ends "Fix the errors above before going on. If a finding is intended, ask the user before accepting it with --allow." Claude Code and Codex give this to the agent as an error. The edit itself has already been made, and nothing undoes it.
- **Warnings and notes only**: they are passed as context, and do not count as an error. The skill tells the agent to decide them with you.
- **Nothing found**: one line of context, which says lint reads files only and a clean lint does not show that no rows leak. [Audit](verify.md#audit-mode) tests that, on the local stack, when you run it.
- **No migrations read**: the message or the context says the RLS rules (`rls-off`, `rls-open`) did not run.
- **An installed skill that differs from the package's**: one line saying `agent init` updates it.

Names from the project's files (file names, streams, tables, policies) are put on one line each, so a name cannot pose as a line of the hook's own. A long list is cut to what a hook may pass, keeping the closing instruction.

A problem of the hook's own never reaches the agent as an error. A payload it cannot read or over 5 MB, or an option it does not take, is a note on stderr with exit 0, which Claude Code shows only in its transcript view, so check the hook command if lint seems never to run. A `--migrations` directory that is not there, or an `--allow` rule that does not exist, is said to the agent as context ("samesight lint could not run: ..."), with exit 0.

An agent that cannot fix a finding gets the error again on each edit to those files. The skill tells it to stop after two tries and ask you.

## Agents

- **Claude Code** runs the hook after `Write`, `Edit` and `MultiEdit`, from `.claude/settings.json`, and reads the skill from `.claude/skills`. Edits it makes with a shell command (`sed -i`, a redirect) do not run the hook; the skill tells it to run lint itself after such edits.
- **Codex** runs the hook from `.codex/hooks.json` after the tools its matcher names (`apply_patch`, `Edit`, `Write`) once you have trusted it, and reads the skill from `.agents/skills`. The hook reads the files an `apply_patch` names. This follows Codex's documented hook format and has not been tried with a running Codex yet.
- **Cursor** runs Claude Code's hooks from `.claude/settings.json` when its third-party hooks setting is on, and reads the skill from `.cursor/skills`. Cursor's support for those hooks has had bugs in some versions, and it has not been tried here. When no hook output arrives, the skill tells the agent to run `npx samesight lint --format json` itself.
- **Other agents** that read `.agents/skills` (GitHub Copilot, Windsurf and Cline document it) get the skill, which tells them to run lint after each such edit, but not the hook.

## Removing it

Delete the samesight entry from `hooks.PostToolUse` in `.claude/settings.json` and `.codex/hooks.json`, and the `samesight` directories under `.claude/skills`, `.agents/skills` and `.cursor/skills`.

## Lint's JSON

The skill tells agents to run `npx samesight lint --format json`. The document is versioned and has a published schema, `samesight/schema/lint.schema.json`; it is printed on every exit, with `error` saying why when lint could not run. See [lint](cli.md#lint).
