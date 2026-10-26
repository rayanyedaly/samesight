#!/usr/bin/env node
/**
 * The published packages move in lockstep: one version for all four.
 *
 *   node scripts/version.mjs 0.2.0   set every package to 0.2.0
 *   node scripts/version.mjs --check v0.2.0   fail unless every package is 0.2.0 (the release job)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = ["samesight", "verify", "supabase", "next"].map((p) => join(ROOT, "packages", p, "package.json"));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const [first, second] = process.argv.slice(2);
const check = first === "--check";
const version = (check ? second : first)?.replace(/^v/, "");
if (!version || !SEMVER.test(version)) {
  console.error("Usage: node scripts/version.mjs <version> | --check <tag>");
  process.exit(1);
}

let wrong = 0;
for (const path of PACKAGES) {
  const text = readFileSync(path, "utf8");
  const pkg = JSON.parse(text);
  if (check) {
    if (pkg.version !== version) {
      console.error(`${pkg.name} is ${pkg.version}, not ${version}`);
      wrong++;
    }
    continue;
  }
  // Replace the version field in place, so the file keeps its formatting.
  writeFileSync(path, text.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));
  console.log(`${pkg.name} ${pkg.version} -> ${version}`);
}
if (check && !wrong) console.log(`Every package is ${version}.`);
process.exitCode = wrong ? 1 : 0;
