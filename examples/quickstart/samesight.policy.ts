import { claim, col, definePolicy, table, via } from "samesight";
// Regenerate after a schema migration: supabase gen types typescript --local --schema public > supabase/types.ts
import type { Database } from "./supabase/types.ts";

// Drafted by `samesight init` from the local database. As written, every role reads
// every row of its own tenant, each user reads their own members row, and
// clients write nothing. Narrow the read rules and add write rules (write, insert,
// update, delete), then run `samesight generate`. `samesight explain` prints the result.

export default definePolicy<Database>({
  auth: "supabase",
  claims: {
    tenant: claim.uuid("tenant_id"),
    // Supabase reserves "role" for the Postgres role, so the app role is "app_role".
    role: claim.oneOf("app_role", ["owner", "member"]),
  },
  membership: { table: "members", user: "user_id", tenant: "org_id", role: "role" },
  tables: {
    organizations: table({ tenant: "id", read: { "*": true } }),
    members: table({ tenant: "org_id", read: { owner: true, member: col("user_id").eq(claim.user) } }),
    projects: table({ tenant: "org_id", read: { "*": true }, write: { owner: true }, serverOwned: ["created_at"] }),
    tasks: table({
      tenant: "org_id",
      read: { "*": via("project_id", "projects") },
      insert: { "*": true },
      update: { owner: true, member: col("assignee_id").eq(claim.user) },
      delete: { owner: true },
      author: "created_by",
      serverOwned: ["created_at"],
      immutable: ["project_id"],
      touch: "updated_at",
    }),
  },
});
