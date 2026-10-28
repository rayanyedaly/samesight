# Security

## Supported versions

Samesight is before 1.0: fixes go into the latest 0.x release only.

## Reporting a vulnerability

Report it privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Please do not open a public issue for it.

In scope:

- **Wrong results.** `samesight lint` or `samesight-verify audit` passes, or misses a row, for a sync config that sends a device rows its user's RLS refuses.
- **Generated access rules.** The RLS migration or sync streams that `samesight generate` writes let a user read or write more than the policy says.
- **The verifier's guards.** It runs against anything other than a local stack, or with `NODE_ENV` set to production. It leaves users, rows, roles or containers behind that it says it removed. It prints a secret it was given.
- **`@samesight/supabase` and `@samesight/next`.** They lose writes, apply them to the wrong user, or store data unencrypted where they say they encrypt it.

Out of scope: the PowerSync service and Supabase themselves. Report those to their maintainers.
