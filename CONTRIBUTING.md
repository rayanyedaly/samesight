# Contributing

## Layout

| Path | |
| --- | --- |
| `packages/samesight` | Policy language, compiler, emitters and the `samesight` CLI. |
| `packages/verify` | `samesight-verify`. |
| `packages/supabase`, `packages/next` | The runtime packages. |
| `examples/fieldbook` | The example app, and the stack every verifier test runs against. |
| `examples/quickstart` | The getting-started guide's result: a `supabase init` project with a policy drafted by `samesight init`. |
| `examples/audit-todolist` | Audit mode on PowerSync's to-do list demo, fetched at a pinned commit. |
| `scripts/pack-smoke.mjs` | Packs, installs with npm and uses the packages as a user would. |
| `docs/` | User documentation. |

The workspace runs on the TypeScript source: each package's `exports` and `bin` point at `src/`, and Node runs the CLIs with type stripping. `publishConfig` swaps in `dist/` when a package is packed, so the published packages are plain JavaScript with declarations. Relative imports name the `.ts` file; the build rewrites them to `.js`.

## Setup

Node 22.18 or newer (`.nvmrc`), pnpm 10 and, for the stack tests, Docker.

```bash
pnpm install
```

## Tests, in tiers

| Command | Needs | |
| --- | --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | nothing | Unit tests, including golden files for the emitters. |
| `pnpm --filter fieldbook policy:check` | nothing | Fieldbook's generated files match its policy. |
| `pnpm smoke` | network (npm) | The packed packages, installed with npm outside the workspace. `--no-lint` skips publint and arethetypeswrong. |
| `pnpm --filter fieldbook test:db` | Fieldbook's stack | pgTAP tests of the generated migration. |
| `pnpm --filter @samesight/verify test:stack` | Fieldbook's stack | Catalog tamper cases, the differential and the write path. |
| `pnpm --filter fieldbook policy:verify` | Fieldbook's stack | The full verifier with the mutation test. |
| `pnpm --filter @samesight/verify test:audit` | the to-do demo's stack | Audit mode tamper cases. |

Start the stacks with `pnpm --filter fieldbook stack:up` (then `seed`), `pnpm --filter quickstart stack:up` and `pnpm --filter audit-todolist stack:up`. They run side by side; `pnpm --filter quickstart policy:verify` runs the full verifier on the quickstart.

When an emitter's output changes on purpose, update the golden files in `packages/samesight/src/emit/__golden__` and regenerate Fieldbook (`pnpm --filter fieldbook policy:generate` with its stack up), and say in the changelog what users must do.

## Releasing

All packages share one version.

1. Add the release to `CHANGELOG.md`.
2. `node scripts/version.mjs 0.2.0` and commit.
3. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

The release workflow checks that the tag matches every package, runs the checks, the unit tests and the smoke test, publishes with npm provenance, and creates the GitHub release. A version with a prerelease part (`0.2.0-rc.1`) is published under the `next` tag.

The workflow needs an `NPM_TOKEN` secret in a GitHub environment named `npm`, with publish rights on `samesight` and the `@samesight` npm organization.
