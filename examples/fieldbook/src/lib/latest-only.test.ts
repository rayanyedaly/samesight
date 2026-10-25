import { describe, expect, it } from "vitest";
import { type Finding, latestOnly } from "./latest-only";

function finding(id: string, supersedesId: string | null = null): Finding {
  return {
    id,
    supersedesId,
    tenantId: "t",
    inspectionId: "i",
    seq: null,
    body: id,
    severity: "LOW",
    createdBy: "u",
    createdAt: null,
  };
}

describe("latestOnly", () => {
  it("returns findings with no amendments unchanged, in order", () => {
    const chains = latestOnly([finding("a"), finding("b")]);
    expect(chains.map((c) => [c.latest.id, c.earlier.length])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("shows only the newest row of a chain, with its history newest first", () => {
    const chains = latestOnly([finding("a"), finding("b", "a"), finding("c", "b")]);
    expect(chains).toHaveLength(1);
    expect(chains[0].latest.id).toBe("c");
    expect(chains[0].earlier.map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("keeps an amendment whose original has not synced to this device", () => {
    const chains = latestOnly([finding("b", "missing")]);
    expect(chains.map((c) => c.latest.id)).toEqual(["b"]);
    expect(chains[0].earlier).toEqual([]);
  });

  it("does not depend on input order", () => {
    const chains = latestOnly([finding("c", "b"), finding("b", "a"), finding("a")]);
    expect(chains.map((c) => [c.latest.id, c.earlier.map((f) => f.id)])).toEqual([["c", ["b", "a"]]]);
  });

  it("shows both amendments when one row was amended twice", () => {
    const chains = latestOnly([finding("a"), finding("b", "a"), finding("c", "a")]);
    expect(chains.map((c) => [c.latest.id, c.earlier.map((f) => f.id)])).toEqual([
      ["b", ["a"]],
      ["c", ["a"]],
    ]);
  });

  it("keeps a row that names itself as superseded visible", () => {
    const chains = latestOnly([finding("a", "a")]);
    expect(chains.map((c) => [c.latest.id, c.earlier.length])).toEqual([["a", 0]]);
  });

  it("walks a chain ending in a self-reference once, without repeats", () => {
    const chains = latestOnly([finding("c", "a"), finding("a", "a")]);
    expect(chains.map((c) => [c.latest.id, c.earlier.map((f) => f.id)])).toEqual([["c", ["a"]]]);
  });

  it("terminates on a cycle", () => {
    const chains = latestOnly([finding("x"), finding("a", "b"), finding("b", "a"), finding("c", "a")]);
    expect(chains.map((c) => [c.latest.id, c.earlier.map((f) => f.id)])).toEqual([
      ["x", []],
      ["c", ["a", "b"]],
    ]);
  });
});
