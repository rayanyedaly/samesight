import { defineConfig } from "vitest/config";

// Unit tests only; *.stack.test.ts need Fieldbook's stack (vitest.stack.config.ts), *.audit.test.ts
// the to-do list demo's (vitest.audit.config.ts), *.roles.test.ts audit-roles' (vitest.roles.config.ts).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["src/**/*.stack.test.ts", "src/**/*.audit.test.ts", "src/**/*.roles.test.ts"] },
});
