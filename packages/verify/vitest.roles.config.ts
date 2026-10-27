import { defineConfig } from "vitest/config";

// Audit mode on examples/audit-roles (roles and an org in app_metadata): pnpm --filter
// audit-roles stack:up first (Supabase); tests that need PowerSync start it themselves (Docker).
export default defineConfig({
  test: { include: ["src/**/*.roles.test.ts"], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
