import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  // Supabase Auth redirects to 127.0.0.1 (supabase/config.toml site_url).
  allowedDevOrigins: ["127.0.0.1"],
  agentRules: false,
  turbopack: {
    // The pnpm workspace root, so Turbopack can resolve hoisted dependencies.
    root: join(import.meta.dirname, "../.."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
