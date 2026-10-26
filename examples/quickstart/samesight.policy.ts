import { and, claim, col, definePolicy, rowsOf, table } from "samesight";
// Regenerate after a schema migration: supabase gen types typescript --local --schema public > supabase/types.ts
import type { Database } from "./supabase/types.ts";

// Drafted by `samesight init` from the local database. As written, every role reads
// every row of its own tenant, each user reads their own members row, and
// clients write nothing. Narrow the read rules and add write rules (write, insert,
// update, delete), then run `samesight generate`. `samesight explain` prints the result.

/** The projects a member was added to. */
const myProjects = rowsOf("project_members", "project_id", col("user_id").eq(claim.user));

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
    // Shared by every organization (tenant: null), and read-only to clients. Members see
    // the labels in use; owners also see retired ones.
    labels: table({ tenant: null, read: { owner: true, member: col("status").eq("active") } }),
    members: table({ tenant: "org_id", read: { owner: true, member: col("user_id").eq(claim.user) } }),
    project_members: table({
      tenant: "org_id",
      read: { owner: true, member: col("user_id").eq(claim.user) },
      write: { owner: true },
      immutable: ["project_id", "user_id"],
    }),
    projects: table({
      tenant: "org_id",
      read: { owner: true, member: col("id").in(myProjects) },
      write: { owner: true },
      serverOwned: ["created_at"],
    }),
    tasks: table({
      tenant: "org_id",
      read: { owner: true, member: col("project_id").in(myProjects) },
      insert: { owner: true, member: col("project_id").in(myProjects) },
      update: { owner: true, member: and(col("assignee_id").eq(claim.user), col("project_id").in(myProjects)) },
      delete: { owner: true },
      author: "created_by",
      serverOwned: ["created_at"],
      immutable: ["project_id"],
      touch: "updated_at",
    }),
  },
});
