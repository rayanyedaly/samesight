#!/usr/bin/env node
/**
 * Keeps the output shown in docs/how-sync-configs-leak.md true to the tools. Each block
 * between markers is rewritten:
 *
 *   <!-- lint:<name> -->        `samesight lint corpus/planted/<name>.yaml`, as the built CLI prints it
 *   <!-- /lint -->
 *   <!-- audit:<name> -->       what audit prints on corpus/planted/<name>.yaml before it reads
 *   <!-- /audit -->             the database, from verify's own checkSyncConfig, printed by its
 *                               formatSection: the Sync config section in full, then, when a
 *                               stream query reads user_metadata, the user metadata line of
 *                               Database catalog (computed with no RLS policy; the lines that
 *                               need the database are left out)
 *   <!-- capture:audit-demo --> the differential's failure, from its FAIL line to its replay
 *   <!-- /capture -->           line, copied from docs/assets/audit-demo.txt, the live run
 *                               scripts/demo/capture.sh records
 *
 * Every planted file must have a lint block.
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
const CAPTURE = "docs/assets/audit-demo.txt";
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

for (const built of [CLI, join(VERIFY, "report.js"), join(VERIFY, "audit/config.js")]) {
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

const { failed, formatSection } = await import(pathToFileURL(join(VERIFY, "report.js")).href);
const { checkSyncConfig, checkUserMetadata } = await import(pathToFileURL(join(VERIFY, "audit/config.js")).href);

/**
 * What audit prints on one planted file before it reads the database, as audit/run.ts runs it:
 * each section in verify's own layout, a blank line between them as the CLI prints them.
 */
function auditBlock(name) {
  const file = `${PLANTED}/${name}.yaml`;
  const checked = checkSyncConfig(file, readFileSync(join(ROOT, file), "utf8"));
  const sections = [formatSection("Sync config", checked.findings)];
  // run.ts stops after a failing Sync config section; otherwise Database catalog comes next.
  const metadata = checked.parsed && !failed(checked.findings) ? checkUserMetadata([], checked.parsed.streamSql) : [];
  if (failed(metadata)) {
    // The doc's own note goes under the title, where the lines it leaves out would be.
    sections.push(formatSection("Database catalog", metadata).replace("\n", "\n(the lines that read the database are left out here)\n"));
  }
  const out = lines(sections.join("\n\n"));
  if (!out.some((l) => /^(warn|FAIL) /.test(l))) fail(`audit reports nothing on ${file} before the database; drop its audit block`);
  return ["```text", ...out, "```"];
}

/** The differential's failure in the live capture, from its FAIL line to its replay line. */
function captureBlock() {
  const text = readFileSync(join(ROOT, CAPTURE), "utf8").replace(/\r\n/g, "\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) fail(`${CAPTURE} holds control characters; capture it again with NO_COLOR=1`);
  const all = lines(text);
  const start = all.findIndex((l) => l.startsWith("FAIL  differential: "));
  const end = all.findIndex((l, i) => i > start && /^\s+replay\s/.test(l));
  if (start < 0 || end < 0) fail(`${CAPTURE} has no differential failure with a replay line`);
  return ["```text", ...all.slice(start, end + 1), "```"];
}

function lines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

const path = join(ROOT, DOC);
const before = readFileSync(path, "utf8");
const seen = new Set();
const stale = [];
const after = before.replace(/^<!-- (lint|audit|capture):([a-z0-9-]+) -->\n[\s\S]*?^<!-- \/\1 -->$/gm, (block, kind, name) => {
  let body;
  if (kind === "capture") {
    if (name !== "audit-demo") fail(`${DOC} has a capture block named ${name}; the only capture is audit-demo (${CAPTURE})`);
    body = captureBlock();
  } else {
    if (!planted.includes(name)) fail(`${DOC} has a ${kind} block for ${name}, but there is no ${PLANTED}/${name}.yaml`);
    if (kind === "lint") seen.add(name);
    body = kind === "lint" ? lintBlock(name) : auditBlock(name);
  }
  const fresh = [`<!-- ${kind}:${name} -->`, ...body, `<!-- /${kind} -->`].join("\n");
  if (fresh !== block) stale.push(`${kind}:${name}`);
  return fresh;
});

const missing = planted.filter((n) => !seen.has(n));
if (missing.length) fail(`${DOC} has no lint block for ${missing.map((n) => `${PLANTED}/${n}.yaml`).join(", ")}`);

if (check) {
  if (stale.length) {
    console.error(`${DOC} is stale: the output in ${stale.map((b) => `<!-- ${b} -->`).join(", ")} is not what the tools print now. Run: node scripts/docs/leaks.mjs`);
    process.exit(1);
  }
  console.log(`${DOC}: every generated block is up to date`);
} else if (after !== before) {
  writeFileSync(path, after);
  console.log(`${DOC}: rewrote ${stale.join(", ")}`);
} else {
  console.log(`${DOC}: up to date`);
}
