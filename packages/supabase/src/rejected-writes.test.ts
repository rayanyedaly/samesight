// recordRejectedLocally is the last thing that runs before a refused batch is taken out
// of the upload queue, and the connector awaits it so that a failure prevents that. A
// crash in here therefore does not lose data; it leaves the queue stuck on that write
// forever instead. These cases cover the three real runtimes for generating its ids.
import type { AbstractPowerSyncDatabase } from "@powersync/common";
import { afterEach, describe, expect, it } from "vitest";
import { isPermanentRejection } from "./errors.ts";
import { acknowledgeRejection, type RejectedUpload, recordRejectedLocally } from "./rejected-writes.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Minimal stand-in for the parts of a PowerSync database these functions touch. */
function fakeDb() {
  const rows: unknown[][] = [];
  const statements: string[] = [];
  const execute = async (sql: string, params: unknown[]) => {
    statements.push(sql);
    rows.push(params);
  };
  const db = {
    writeTransaction: async (fn: (tx: { execute: typeof execute }) => Promise<void>) => fn({ execute }),
    execute,
  } as unknown as AbstractPowerSyncDatabase;
  return { db, rows, statements };
}

const upload = (ops: RejectedUpload["ops"]): RejectedUpload => ({
  status: 403,
  code: "42501",
  message: "new row violates row-level security policy",
  ops,
});

const realCrypto = globalThis.crypto;
afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
});
const setCrypto = (value: unknown) => Object.defineProperty(globalThis, "crypto", { value, configurable: true });

describe("recordRejectedLocally", () => {
  const ops = [
    {
      op: "PUT",
      table: "Finding",
      id: "11111111-1111-4111-8111-111111111111",
      data: { body: "Gutter blocked above bay 3" },
    },
    { op: "PATCH", table: "Inspection", id: "22222222-2222-4222-8222-222222222222", data: { status: "DRAFT" } },
  ];

  it("writes one row per op, keeping the payload", async () => {
    const { db, rows } = fakeDb();
    await recordRejectedLocally(db, upload(ops));

    expect(rows).toHaveLength(2);
    const [id, resourceType, resourceId, opType, payload, httpStatus, reasonCode] = rows[0];
    expect(resourceType).toBe("Finding");
    expect(resourceId).toBe(ops[0].id);
    expect(opType).toBe("PUT");
    expect(httpStatus).toBe(403);
    expect(reasonCode).toBe("42501");
    // The payload is the point: it is the only copy left on this device.
    expect(JSON.parse(String(payload))).toEqual({ body: "Gutter blocked above bay 3" });
    expect(String(id)).toMatch(UUID_V4);
  });

  it.each([
    ["browser (crypto.randomUUID)", () => realCrypto],
    [
      "React Native with getRandomValues only",
      () => ({ getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a) }),
    ],
    ["no crypto global at all", () => undefined],
  ])("generates a valid v4 id on %s", async (_label, makeCrypto) => {
    setCrypto(makeCrypto());
    const { db, rows } = fakeDb();
    await recordRejectedLocally(db, upload(ops));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(String(row[0])).toMatch(UUID_V4);
  });

  it("does not collide across a realistic number of rejections", async () => {
    const { db, rows } = fakeDb();
    const many = Array.from({ length: 500 }, (_, i) => ({
      op: "PUT",
      table: "Finding",
      id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
      data: {},
    }));
    await recordRejectedLocally(db, upload(many));
    expect(new Set(rows.map((r) => r[0])).size).toBe(500);
  });
});

describe("acknowledgeRejection", () => {
  it("marks the row and never deletes it", async () => {
    const { db, statements } = fakeDb();
    await acknowledgeRejection(db, "r1");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^UPDATE RejectedWrite SET acknowledgedAt/);
    expect(statements[0]).not.toMatch(/DELETE/i);
  });
});

describe("isPermanentRejection", () => {
  it.each([408, 425, 429, 413])("treats %i as retryable, not poison", (status) => {
    expect(isPermanentRejection(status)).toBe(false);
  });

  it.each([400, 403, 404, 409, 422])("treats %i as a permanent refusal", (status) => {
    expect(isPermanentRejection(status)).toBe(true);
  });

  it("leaves 5xx and 2xx to the caller's other branches", () => {
    expect(isPermanentRejection(500)).toBe(false);
    expect(isPermanentRejection(503)).toBe(false);
    expect(isPermanentRejection(200)).toBe(false);
  });
});
