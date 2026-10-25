import { defineConfig } from "vitest/config";

// Tests against the running local stack: pnpm --filter fieldbook stack:up first.
export default defineConfig({
  test: { include: ["src/**/*.stack.test.ts"], testTimeout: 60_000, fileParallelism: false },
});
