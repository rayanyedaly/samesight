import { defineConfig } from "vitest/config";

// Unit tests only; *.stack.test.ts need the local Supabase stack (vitest.stack.config.ts).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.stack.test.ts"] },
});
