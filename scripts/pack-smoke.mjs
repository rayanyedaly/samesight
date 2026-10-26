#!/usr/bin/env node
/**
 * Packs every published package the way `pnpm publish` would, installs the tarballs with
 * npm into fresh projects outside the workspace, and uses them as a user would: both CLIs,
 * `samesight check` and `explain` on Fieldbook's policy, policy loading under CommonJS and
 * as .mts, `init` with no database, the runtime packages imported by plain Node, and
 * consumer code type-checked under several TypeScript versions and module resolutions.
 *
 *   node scripts/pack-smoke.mjs [--no-lint] [--keep]
 *
 * --no-lint skips publint and arethetypeswrong (they are fetched with npx). --keep leaves
 * the scratch directory in place and prints its path.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIELDBOOK = join(ROOT, "examples/fieldbook");
const PACKAGES = ["samesight", "verify", "supabase", "next"];
// Pinned so the check does not move under us; TypeScript versions a user may well have.
const PUBLINT = "publint@0.3.25";
const ATTW = "@arethetypeswrong/cli@0.18.5";
const TYPESCRIPTS = ["5.9.3", "7.0.2"];

const args = new Set(process.argv.slice(2));
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "samesight-smoke-"));
let failures = 0;

/** npm, npx and pnpm are .cmd shims on Windows and need a shell there; node runs directly, so its arguments need no quoting. */
function run(cmd, argv, opts = {}) {
  const node = cmd === "node";
  const shell = win && !node;
  // cmd.exe joins arguments with spaces and does not quote them.
  const args = shell ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : argv;
  return execFileSync(node ? process.execPath : cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell, ...opts });
}

/** Runs a command that must fail; returns its stderr and stdout. */
function runFailing(cmd, argv, opts = {}) {
  try {
    const out = run(cmd, argv, opts);
    throw new Error(`expected \`${cmd} ${argv.join(" ")}\` to fail, but it printed:\n${out}`);
  } catch (e) {
    if (e.status === undefined) throw e;
    return `${e.stderr}${e.stdout}`;
  }
}

function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  try {
    fn();
    process.stdout.write("ok\n");
  } catch (e) {
    failures++;
    process.stdout.write(`FAILED\n${String(e.stderr ?? "")}${String(e.stdout ?? "")}${e.message}\n`);
  }
}

function expectIn(text, needle, what) {
  if (!text.includes(needle)) throw new Error(`${what}: expected to find ${JSON.stringify(needle)} in:\n${text}`);
}

function project(name, pkg) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `smoke-${name}`, private: true, ...pkg }, null, 2)}\n`);
  return dir;
}

// 1. Pack (prepack builds each package first).
const packs = join(work, "packs");
mkdirSync(packs);
const tarball = {};
const version = {};
for (const p of PACKAGES) {
  const dir = join(ROOT, "packages", p);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  version[p] = manifest.version;
  const before = new Set(readdirSync(packs));
  run("pnpm", ["pack", "--pack-destination", packs], { cwd: dir });
  const made = readdirSync(packs).find((f) => !before.has(f));
  if (!made) throw new Error(`pnpm pack wrote nothing for ${p}`);
  tarball[p] = join(packs, made);
}
console.log(`Packed ${PACKAGES.map((p) => `${p}@${version[p]}`).join(", ")} into ${packs}`);

// 2. Package lint.
if (!args.has("--no-lint")) {
  for (const p of PACKAGES) {
    step(`publint ${p}`, () => run("npx", ["--yes", PUBLINT, "--strict", tarball[p]]));
    step(`arethetypeswrong ${p}`, () =>
      run("npx", ["--yes", ATTW, tarball[p], "--profile", "esm-only", "--format", "ascii", ...(p === "next" ? ["--exclude-entrypoints", "styles.css"] : [])]),
    );
  }
}

// 3. The CLIs, in a project with no "type" (as `npm init` and create-next-app leave it).
const cli = project("cli", {});
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball.samesight, tarball.verify], { cwd: cli });
const samesight = (...a) => run("npx", ["--no-install", "samesight", ...a], { cwd: cli });

step("samesight --version", () => expectIn(samesight("--version"), version.samesight, "version"));
step("samesight-verify --version", () => expectIn(run("npx", ["--no-install", "samesight-verify", "--version"], { cwd: cli }), version.verify, "version"));
step("samesight-verify --help", () => expectIn(run("npx", ["--no-install", "samesight-verify", "--help"], { cwd: cli }), "samesight-verify audit", "help"));

// Fieldbook's policy and generated files, as a project of its own.
for (const p of ["samesight.policy.ts", "supabase/types.ts", "powersync", "samesight", "src/lib/powersync/schema.ts", "src/lib/policy-types.ts"]) {
  cpSync(join(FIELDBOOK, p), join(cli, p), { recursive: true });
}
mkdirSync(join(cli, "supabase/migrations"), { recursive: true });
for (const f of readdirSync(join(FIELDBOOK, "supabase/migrations")).filter((f) => f.endsWith("_samesight.sql"))) {
  cpSync(join(FIELDBOOK, "supabase/migrations", f), join(cli, "supabase/migrations", f));
}
step("samesight check on Fieldbook", () => expectIn(samesight("check"), "Generated files match the policy.", "check"));
step("samesight explain", () => {
  const out = samesight("explain");
  expectIn(out, "Inspection  RIUD       r-u-       r---", "explain matrix");
  expectIn(out, "never synced to VIEWER: internalNotes", "explain hide");
});
step("samesight check catches drift", () => {
  const path = join(cli, "powersync/sync-config.yaml");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}# edited\n`);
  try {
    expectIn(runFailing("npx", ["--no-install", "samesight", "check"], { cwd: cli }), "powersync/sync-config.yaml differs from the policy", "drift");
  } finally {
    writeFileSync(path, original);
  }
});
step('a .ts policy under "type": "commonjs" names the fix', () => {
  const pkgPath = join(cli, "package.json");
  const pkg = readFileSync(pkgPath, "utf8");
  writeFileSync(pkgPath, JSON.stringify({ ...JSON.parse(pkg), type: "commonjs" }));
  try {
    expectIn(runFailing("npx", ["--no-install", "samesight", "check"], { cwd: cli }), "Rename it to samesight.policy.mts", "commonjs");
    renameSync(join(cli, "samesight.policy.ts"), join(cli, "samesight.policy.mts"));
    expectIn(samesight("check"), "Generated files match the policy.", "check .mts");
  } finally {
    writeFileSync(pkgPath, pkg);
    if (existsSync(join(cli, "samesight.policy.mts"))) renameSync(join(cli, "samesight.policy.mts"), join(cli, "samesight.policy.ts"));
  }
});
step("samesight init without a database writes a template", () => {
  const dir = join(cli, "fresh");
  mkdirSync(dir);
  const out = run("npx", ["--no-install", "samesight", "init", "--db", "postgresql://postgres:postgres@127.0.0.1:1/postgres"], { cwd: dir });
  expectIn(out, "writing a template instead", "init");
  expectIn(readFileSync(join(dir, "samesight.policy.mts"), "utf8"), "definePolicy<Database>", "init template");
});
step("samesight refuses a hosted database", () =>
  expectIn(runFailing("npx", ["--no-install", "samesight", "generate", "--db", "postgresql://u:p@db.example.supabase.co/postgres"], { cwd: cli }), "only connects to a local database", "local only"),
);

// 4. The runtime packages, imported by Node and type-checked as a consumer would.
const lib = project("lib", { type: "module" });
const peers = ["@powersync/common@2.4.0", "@powersync/web@2.5.0", "@powersync/react@2.1.0", "@supabase/supabase-js@2.118.0", "react@19", "@types/react@19", "@types/node@22"];
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball.samesight, tarball.supabase, tarball.next, ...peers], { cwd: lib });
step("node imports @samesight/supabase", () => {
  const out = run(
    "node",
    ["--input-type=module", "-e", 'import { latestOnly, classifyUploadError } from "@samesight/supabase"; console.log(typeof latestOnly, typeof classifyUploadError);'],
    { cwd: lib },
  );
  expectIn(out, "function function", "import");
});
step("node imports samesight", () =>
  expectIn(run("node", ["--input-type=module", "-e", 'import { definePolicy } from "samesight"; console.log(typeof definePolicy);'], { cwd: lib }), "function", "import"),
);
cpSync(join(FIELDBOOK, "samesight.policy.ts"), join(lib, "samesight.policy.ts"));
cpSync(join(FIELDBOOK, "supabase/types.ts"), join(lib, "supabase/types.ts"));
writeFileSync(
  join(lib, "consumer.tsx"),
  `import { latestOnly, SupabaseConnector, type SupersedingRow } from "@samesight/supabase";
import { createEncryptedStore, SamesightProvider, SyncStatusChip, type SamesightProviderProps } from "@samesight/next";
import policy from "./samesight.policy.ts";

const rows: SupersedingRow[] = [];
export const latest = latestOnly(rows);
export const connector: typeof SupabaseConnector = SupabaseConnector;
export const store: typeof createEncryptedStore = createEncryptedStore;
export const ui = [SamesightProvider, SyncStatusChip];
export type Props = SamesightProviderProps;
export const kind: "samesight-policy" = policy.kind;
`,
);
for (const ts of TYPESCRIPTS) {
  const dir = join(lib, `ts-${ts}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", `typescript@${ts}`], { cwd: dir });
  for (const resolution of [
    { module: "nodenext", moduleResolution: "nodenext" },
    { module: "esnext", moduleResolution: "bundler" },
  ]) {
    step(`TypeScript ${ts}, ${resolution.moduleResolution}`, () => {
      const config = join(lib, `tsconfig.${ts}.${resolution.moduleResolution}.json`);
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            ...resolution,
            target: "es2022",
            lib: ["es2022", "dom", "dom.iterable"],
            jsx: "react-jsx",
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            // Third-party declarations (Supabase, PowerSync) do not all pass a full check.
            skipLibCheck: true,
            types: ["node"],
          },
          files: ["consumer.tsx"],
        }),
      );
      run("node", [join(dir, "node_modules/typescript/bin/tsc"), "-p", config], { cwd: lib });
    });
  }
}

if (args.has("--keep")) console.log(`\nKept ${work}`);
else rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} smoke check(s) FAILED` : "\nAll smoke checks passed.");
process.exitCode = failures ? 1 : 0;
