import type { AbstractPowerSyncDatabase } from "@powersync/common";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { SupabaseConnector } from "./connector";

type RpcResult = { error: { code?: string; message: string } | null; status: number };

function setup(
  results: RpcResult[],
  options: { localRecordFails?: boolean; owner?: string | null; sessionUser?: string } = {},
) {
  const headers: [string, string][] = [];
  const call = vi.fn(async (_fn: string, _args: unknown): Promise<RpcResult> => results.shift() ?? { error: null, status: 204 });
  // supabase.rpc returns a builder; the connector chains .abortSignal() on apply_batch.
  const rpc = vi.fn((fn: string, args: unknown) => {
    const result = call(fn, args);
    const builder = Object.assign(result, {
      abortSignal: () => builder,
      setHeader: (k: string, v: string) => {
        headers.push([k, v]);
        return builder;
      },
    });
    return builder;
  });
  const refreshSession = vi.fn(async () => ({ data: {}, error: null }));
  const getSession = vi.fn(async () => ({
    data: { session: options.sessionUser ? { access_token: `jwt-${options.sessionUser}`, user: { id: options.sessionUser } } : null },
    error: null,
  }));
  const supabase = { rpc, auth: { refreshSession, getSession } } as unknown as SupabaseClient;

  const complete = vi.fn(async () => {});
  const crud = [
    { op: "PUT", table: "Finding", id: "f1", opData: { body: "lost text" } },
    { op: "PATCH", table: "Inspection", id: "i1", opData: { status: "DRAFT" } },
  ];
  const localRows: unknown[][] = [];
  const db = {
    getNextCrudTransaction: async () => ({ crud, complete }),
    writeTransaction: async (fn: (tx: { execute: (sql: string, p: unknown[]) => Promise<void> }) => Promise<void>) => {
      if (options.localRecordFails) throw new Error("disk full");
      await fn({ execute: async (_sql, params) => void localRows.push(params) });
    },
  } as unknown as AbstractPowerSyncDatabase;

  const onStuck = vi.fn();
  const onUploaded = vi.fn();
  const connector = new SupabaseConnector({
    supabase,
    powersyncUrl: "http://ps",
    onStuck,
    onUploaded,
    ...(options.owner !== undefined ? { ownerId: () => options.owner ?? null } : {}),
  });
  return { connector, db, rpc, call, headers, refreshSession, complete, localRows, onStuck, onUploaded };
}

describe("SupabaseConnector.uploadData", () => {
  it("sends the whole transaction as one apply_batch call and completes it", async () => {
    const { connector, db, rpc, complete } = setup([{ error: null, status: 204 }]);
    await connector.uploadData(db);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("apply_batch", {
      ops: [
        { op: "PUT", table: "Finding", id: "f1", data: { body: "lost text" } },
        { op: "PATCH", table: "Inspection", id: "i1", data: { status: "DRAFT" } },
      ],
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("records a refused batch locally, sends a server copy, then completes", async () => {
    const { connector, db, rpc, complete, localRows } = setup([
      { error: { code: "42501", message: "rls" }, status: 403 },
    ]);
    await connector.uploadData(db);
    expect(localRows).toHaveLength(2);
    expect(rpc).toHaveBeenLastCalledWith("record_rejection", {
      rejections: expect.arrayContaining([expect.objectContaining({ table: "Finding", id: "f1", code: "42501" })]),
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("keeps the batch queued when the local record fails", async () => {
    const { connector, db, complete } = setup([{ error: { code: "P0001", message: "refused" }, status: 400 }], {
      localRecordFails: true,
    });
    await expect(connector.uploadData(db)).rejects.toThrow("disk full");
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes even when the server copy fails", async () => {
    const { connector, db, call, complete } = setup([{ error: { code: "23503", message: "fk" }, status: 409 }]);
    call.mockImplementationOnce(async () => ({ error: { code: "23503", message: "fk" }, status: 409 }));
    call.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await connector.uploadData(db);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries temporary failures without completing", async () => {
    const { connector, db, complete } = setup([{ error: { message: "fetch failed" }, status: 0 }]);
    await expect(connector.uploadData(db)).rejects.toThrow(/will retry/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("refreshes the session on 401 and retries", async () => {
    const { connector, db, complete, refreshSession } = setup([
      { error: { code: "PGRST303", message: "JWT expired" }, status: 401 },
    ]);
    await expect(connector.uploadData(db)).rejects.toThrow(/refreshed/);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("holds an oversized batch and reports it", async () => {
    const { connector, db, complete, onStuck, localRows } = setup([
      { error: { message: "Payload Too Large" }, status: 413 },
    ]);
    await expect(connector.uploadData(db)).rejects.toThrow(/held/);
    expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ status: 413, opCount: 2 }));
    expect(localRows).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("SupabaseConnector owner check", () => {
  it("never uploads one user's queue under another user's session", async () => {
    const { connector, db, rpc, complete } = setup([], { owner: "A", sessionUser: "B" });
    await expect(connector.uploadData(db)).rejects.toThrow(/does not belong/);
    await expect(connector.fetchCredentials()).rejects.toThrow(/does not belong/);
    expect(rpc).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses while the store has no owner (locked)", async () => {
    const { connector, db, rpc } = setup([], { owner: null, sessionUser: "A" });
    await expect(connector.uploadData(db)).rejects.toThrow(/does not belong/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uploads for the owner with the token it checked, and reports it", async () => {
    const { connector, db, complete, onUploaded, headers } = setup([], { owner: "A", sessionUser: "A" });
    await connector.uploadData(db);
    expect(headers).toEqual([["Authorization", "Bearer jwt-A"]]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("refreshes once for a token without a tenant, then holds and reports", async () => {
    const noTenant = { error: { code: "28000", message: "no tenant" }, status: 401 };
    const { connector, db, refreshSession, onStuck, complete } = setup([noTenant, noTenant]);
    await expect(connector.uploadData(db)).rejects.toThrow(/refreshed/);
    await expect(connector.uploadData(db)).rejects.toThrow(/held/);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onStuck).toHaveBeenCalledWith(expect.objectContaining({ code: "28000" }));
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("SupabaseConnector.uploadData edge cases", () => {
  it("holds a batch when the response is not 2xx, even without an error", async () => {
    const { connector, db, complete, onStuck } = setup([{ error: null, status: 404 }]);
    await expect(connector.uploadData(db)).rejects.toThrow(/held/);
    expect(onStuck).toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes a rejected batch even when the server copy fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { connector, db, complete, localRows } = setup([
      { error: { code: "P0001", message: "refused" }, status: 400 },
      { error: { code: "42501", message: "no" }, status: 403 },
    ]);
    await connector.uploadData(db);
    expect(localRows).toHaveLength(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("SupabaseConnector.fetchCredentials", () => {
  const make = (session: unknown, error: unknown, isSignedIn?: () => boolean) =>
    new SupabaseConnector({
      supabase: { auth: { getSession: async () => ({ data: { session }, error }) } } as unknown as SupabaseClient,
      powersyncUrl: "http://ps",
      isSignedIn,
    });

  it("returns the endpoint and the access token", async () => {
    await expect(make({ access_token: "jwt" }, null).fetchCredentials()).resolves.toEqual({
      endpoint: "http://ps",
      token: "jwt",
    });
  });

  it("throws (retry) when the session cannot be refreshed, rather than signing out", async () => {
    await expect(make(null, new Error("offline")).fetchCredentials()).rejects.toThrow("offline");
    await expect(make(null, null, () => true).fetchCredentials()).rejects.toThrow(/cannot be refreshed/);
  });

  it("returns null only when signed out", async () => {
    await expect(make(null, null, () => false).fetchCredentials()).resolves.toBeNull();
    await expect(make(null, null).fetchCredentials()).resolves.toBeNull();
  });
});
