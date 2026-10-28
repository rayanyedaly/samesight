---
layout: home

hero:
  name: Samesight
  text: Your database and your devices see the same rows
  tagline: PowerSync replicates past row level security, so the sync config alone decides which rows reach a device.
  actions:
    - theme: brand
      text: How sync configs leak
      link: /how-sync-configs-leak
    - theme: alt
      text: Why I built this
      link: /why
    - theme: alt
      text: GitHub
      link: https://github.com/rayanyedaly/samesight

features:
  - title: Lint
    details: Reads the sync config and the SQL migrations and flags known leak patterns in seconds. No database, no Docker, no policy.
    link: /cli#lint
    linkText: samesight lint
  - title: Audit
    details: Signs up test users, syncs a real PowerSync device for each one, and compares every row each device got with what RLS returns for the same user.
    link: /verify#audit-mode
    linkText: Audit mode
  - title: Policy
    details: One policy file generates both the RLS migration and the PowerSync sync streams, and `samesight check` fails CI if either drifts from it.
    link: /getting-started
    linkText: Getting started
---

## Try it

Lint the sync config and the SQL migrations for known leak patterns. It reads files only:

```bash
npx samesight lint sync-config.yaml --migrations supabase/migrations
```

Then audit the rows themselves. Audit needs the project's local Supabase stack and Docker, and `@samesight/verify` installed next to `samesight`:

```bash
npm install -D samesight @samesight/verify supabase
npx supabase start
npx samesight audit --project . --sync-config sync-config.yaml
```

<img class="light-only" alt="samesight audit on the to-do list demo with a leak planted: it fails, names the stream query that sent another user's list, the RLS policy that refused it, and the filter to add" src="./assets/audit-demo-light.svg#gh-light-mode-only">
<img class="dark-only" alt="samesight audit on the to-do list demo with a leak planted: it fails, names the stream query that sent another user's list, the RLS policy that refused it, and the filter to add" src="./assets/audit-demo-dark.svg#gh-dark-mode-only">

That is PowerSync's to-do list demo with one owner filter removed from its sync config. [How sync configs leak](how-sync-configs-leak.md) walks through the patterns lint and audit catch.
