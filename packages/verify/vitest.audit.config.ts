import { defineConfig } from "vitest/config";

// Audit mode against PowerSync's to-do list demo: pnpm --filter audit-todolist stack:up first.
export default defineConfig({
  test: { include: ["src/**/*.audit.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
