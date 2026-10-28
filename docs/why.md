# Why I built this

I built an EMR and patient management system for a developing country. Patients had an offline-first mobile app, and doctors and clinics had a web dashboard. Both ran on cloud-hosted Postgres, with PowerSync syncing data to the devices so the app kept working without a connection.

Patient records are PII and PHI. PowerSync reads the database with a replication role that sees every row, so the sync config alone decided which records landed on which phone. One wrong filter, and a patient's history could sit on someone else's device, readable offline, with nothing failing to tell me.

I checked by hand at first. That doesn't last: every change to the backend, the schema, the sync config or the sync engine itself was another chance for a filter to go missing, and checking by hand each time was slow and easy to skip. So I wrote a small script I could run whenever I changed something, and it gave me an answer instead of a worry.

Then I thought other PowerSync developers might have the same worry, or have had it already. Why not build something that works for any PowerSync project, for the other developers out there? Samesight is that script, grown up:

- **[Lint](cli.md#lint)** reads a sync config, and the SQL migrations when you have them, and flags the patterns that leak, in seconds, with nothing to start.
- **[Audit](verify.md#audit-mode)** signs up test users, generates rows, syncs a real PowerSync device for each user and compares every row each device got with what the database allows that user. When a device holds a row it should not, audit names the query that sent it, the policy that refuses it and, when it can, the filter to add.
- **[The policy compiler](getting-started.md)** goes further: write who may see what once, and generate both the database policies and the sync config from it, so the two cannot drift apart.

Lint reads any PowerSync sync config. Audit and the policy compiler work with Supabase today, where row level security in the database is what each device is compared against.

If you sync data people trust you with, I hope samesight gives you the same answer it gave me, sooner than I found it.

Rayan
