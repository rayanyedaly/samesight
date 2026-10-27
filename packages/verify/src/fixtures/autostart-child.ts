/**
 * A child process for autostart.audit.test.ts: auto-starts PowerSync on the to-do list
 * demo, prints READY and its URL, then waits to be killed. Not shipped (src/fixtures).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { autoStart } from "../autostart/run.ts";
import { connectLocal } from "../db.ts";
import { readStack } from "../stack.ts";

const demo = fileURLToPath(new URL("../../../../examples/audit-todolist/upstream/", import.meta.url));
const stack = readStack(demo, "http://127.0.0.1:1");
const client = await connectLocal(stack.db);
const started = await autoStart({
  projectDir: demo,
  client,
  api: stack.api,
  ...(stack.jwtSecret ? { jwtSecret: stack.jwtSecret } : {}),
  syncConfig: readFileSync(`${demo}sync-config.yaml`, "utf8"),
  tables: ["lists", "todos"],
  log: (line) => process.stderr.write(`${line}\n`),
});
process.stdout.write(`READY ${started.url}\n`);
setInterval(() => {}, 60_000);
