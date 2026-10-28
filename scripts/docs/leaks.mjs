#!/usr/bin/env node
/**
 * Keeps the output shown in docs/how-sync-configs-leak.md true to the CLI. Each block
 * between markers is rewritten from a run on a file in corpus/planted/:
 *
 *   <!-- lint:<name> -->    `samesight lint corpus/planted/<name>.yaml`, as the built CLI prints it
 *   <!-- /lint -->
 *   <!-- audit:<name> -->   what audit says of corpus/planted/<name>.yaml before it needs a
 *   <!-- /audit -->         database: its sync config warnings and the user_metadata check
 *
 * Every planted file must have a lint block. The audit block of the to-do list leak
 * (<!-- capture:... -->) is a live run against Supabase and PowerSync: it is
 * hand-maintained, pasted from `pnpm --filter audit-todolist verify:planted`, and this
 * script never touches it.
 *
 *   node scripts/docs/leaks.mjs           rewrite the blocks
 *   node scripts/docs/leaks.mjs --check   exit 1 if any block differs from a fresh run
 *
 * It runs the built packages: `pnpm build:packages` first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC = "docs/how-sync-configs-leak.md";
const PLANTED = "corpus/planted";
const CLI = join(ROOT, "packages/samesight/dist/cli.js");
const VERIFY = join(ROOT, "packages/verify/dist");

const args = process.argv.slice(2);
const check = args.includes("--check");
if (args.some((a) => a !== "--check")) {
  console.error("Usage: node scripts/docs/leaks.mjs [--check]");
  process.exit(2);
}

function fail(message) {
  console.error(`leaks.mjs: ${message}`);
  process.exit(2);
}

for (const built of [CLI, join(VERIFY, "report.js")]) {
  if (!existsSync(built)) fail(`${built} is missing; run pnpm build:packages first`);
}

const planted = readdirSync(join(ROOT, PLANTED))
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.slice(0, -".yaml".length))
  .sort();

/** Plain text, whatever the environment asks for. */
const env = { ...process.env, NO_COLOR: "1" };
delete env.FORCE_COLOR;

/** `samesight lint` on one planted file, from the repository root so paths stay relative. */
function lintBlock(name) {
  const file = `${PLANTED}/${name}.yaml`;
  const r = spawnSync(process.execPath, [CLI, "lint", file], { cwd: ROOT, env, encoding: "utf8" });
  // 0 and 1 are a lint that ran; anything else could not run.
  if (r.status !== 0 && r.status !== 1) fail(`samesight lint ${file} exited ${r.status}: ${r.stderr || r.error}`);
  // Notes (no migrations here) go to stderr; the doc shows the findings on stdout.
  return ["```console", `$ npx samesight lint ${file}`, ...lines(r.stdout), "```"];
}

const { formatFindings } = await import(pathToFileURL(join(VERIFY, "report.js")).href);
const { checkUserEditableClaims } = await import(pathToFileURL(join(VERIFY, "audit/catalog.js")).href);
const { syncRules } = await import(pathToFileURL(join(VERIFY, "audit/claims.js")).href);
const { auditScope, parseSyncConfig } = await import(pathToFileURL(join(ROOT, "packages/samesight/dist/compiler.js")).href);

/** What audit reports on one planted file before it reads the database: every finding that is not ok. */
function auditBlock(name) {
  const config = parseSyncConfig(readFileSync(join(ROOT, PLANTED, `${name}.yaml`), "utf8"));
  const findings = [...auditScope(config.streams, config.kind).findings, ...config.findings, ...checkUserEditableClaims(syncRules(config))].filter(
    (f) => f.status !== "ok",
  );
  if (!findings.length) fail(`audit reports nothing on ${PLANTED}/${name}.yaml before the database; drop its audit block`);
  return ["```text", ...lines(formatFindings(findings)), "```"];
}

function lines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

const path = join(ROOT, DOC);
const before = readFileSync(path, "utf8");
const seen = new Set();
const stale = [];
const after = before.replace(/^<!-- (lint|audit):([a-z0-9-]+) -->\n[\s\S]*?^<!-- \/\1 -->$/gm, (block, kind, name) => {
  if (!planted.includes(name)) fail(`${DOC} has a ${kind} block for ${name}, but there is no ${PLANTED}/${name}.yaml`);
  if (kind === "lint") seen.add(name);
  const body = kind === "lint" ? lintBlock(name) : auditBlock(name);
  const fresh = [`<!-- ${kind}:${name} -->`, ...body, `<!-- /${kind} -->`].join("\n");
  if (fresh !== block) stale.push(`${kind}:${name}`);
  return fresh;
});

const missing = planted.filter((n) => !seen.has(n));
if (missing.length) fail(`${DOC} has no lint block for ${missing.map((n) => `${PLANTED}/${n}.yaml`).join(", ")}`);

if (check) {
  if (stale.length) {
    console.error(`${DOC} is stale: the output in ${stale.map((b) => `<!-- ${b} -->`).join(", ")} is not what the CLI prints now. Run: node scripts/docs/leaks.mjs`);
    process.exit(1);
  }
  console.log(`${DOC}: every generated block matches the CLI`);
} else if (after !== before) {
  writeFileSync(path, after);
  console.log(`${DOC}: rewrote ${stale.join(", ")}`);
} else {
  console.log(`${DOC}: up to date`);
}
