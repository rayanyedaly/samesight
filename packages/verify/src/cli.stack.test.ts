/**
 * Policy mode on Fieldbook, run as a user would, against the running local stack: a
 * PowerSync service that is not there stops the run before it makes anything.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLocal } from "./db.ts";
import { EMAIL_DOMAIN } from "./differential/users.ts";
import { FIELDBOOK } from "./fixtures/fieldbook.ts";
import { readStack } from "./stack.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

let client: pg.Client;
beforeAll(async () => {
  client = await connectLocal(readStack(FIELDBOOK, process.env.SAMESIGHT_POWERSYNC_URL ?? "http://127.0.0.1:8080").db);
});
afterAll(async () => {
  await client?.end();
});

const users = async () =>
  Number((await client.query<{ n: string }>("select count(*) as n from auth.users where email like $1", [`%@${EMAIL_DOMAIN}`])).rows[0]?.n);

describe("samesight-verify with no PowerSync at --powersync", () => {
  it("exits 2 after the catalog, saying how to start it, and creates no users", async () => {
    const before = await users();
    const result = await new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, "--powersync", "http://127.0.0.1:1"], { cwd: FIELDBOOK, timeout: 50_000 }, (e, stdout, stderr) =>
        resolve({ code: e ? (typeof e.code === "number" ? e.code : `killed (${e.signal}): timed out?`) : 0, stdout, stderr }),
      );
    });
    expect([result.code, result.stderr], result.stdout).toEqual([
      2,
      expect.stringContaining("samesight-verify: PowerSync is not reachable at http://127.0.0.1:1; start it (docker compose up powersync) or pass --powersync <url>"),
    ]);
    // The static checks and the catalog ran first, and passed.
    expect(result.stdout).toContain("Database catalog");
    expect(result.stdout).not.toContain("creating users");
    expect(await users()).toBe(before);
  });
});
