import { describe, expect, it } from "vitest";
import { earlierVersions, latestOnly, type SupersedingRow } from "./latest-only.ts";

describe("latestOnly: append-only chain reduction (server-seq fork resolution)", () => {
  it("drops a row that a later row supersedes (linear chain)", () => {
    const rows = [
      { id: "a", supersedesId: null, seq: 1 },
      { id: "b", supersedesId: "a", seq: 2 },
    ];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["b"]);
  });

  it("keeps distinct origins (different rows, not a chain)", () => {
    const rows = [
      { id: "a", supersedesId: null, seq: 1 },
      { id: "b", supersedesId: null, seq: 2 },
    ];
    expect(
      latestOnly(rows)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("resolves a fork by server seq: two devices amend the same parent, the highest seq wins", () => {
    const rows = [
      { id: "a", supersedesId: null, seq: 10 },
      { id: "b", supersedesId: "a", seq: 30 },
      { id: "c", supersedesId: "a", seq: 31 },
    ];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["c"]);
  });

  it("prunes the whole losing branch: a correction on the losing fork does not resurface", () => {
    const rows = [
      { id: "R1", supersedesId: null, seq: 10 },
      { id: "R2", supersedesId: "R1", seq: 20 },
      { id: "R3", supersedesId: "R1", seq: 21 },
      { id: "R4", supersedesId: "R2", seq: 22 },
    ];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["R3"]);
  });

  it("resolves a deeper losing branch (grandchild) against the fork winner", () => {
    const rows = [
      { id: "P", supersedesId: null, seq: 10 },
      { id: "C1", supersedesId: "P", seq: 12 },
      { id: "C1prime", supersedesId: "P", seq: 15 },
      { id: "C2", supersedesId: "C1", seq: 18 },
    ];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["C1prime"]);
  });

  it("keeps a row whose superseded ancestor is absent from the set", () => {
    const rows = [{ id: "b", supersedesId: "a", seq: 5 }];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["b"]);
  });

  it("picks one head when seq is absent, never two and never a crash", () => {
    const rows: SupersedingRow[] = [
      { id: "a", supersedesId: null },
      { id: "b", supersedesId: "a" },
      { id: "c", supersedesId: "a" },
    ];
    const kept = latestOnly(rows).map((r) => r.id);
    expect(kept).toHaveLength(1);
    expect(["b", "c"]).toContain(kept[0]);
  });

  // Beyond the ported cases:

  it("ranks a row that has not synced yet (seq null) after every synced row", () => {
    // The local amendment b will get the highest seq when the server applies it.
    const rows = [
      { id: "a", supersedesId: null, seq: 10 },
      { id: "c", supersedesId: "a", seq: 31 },
      { id: "b", supersedesId: "a", seq: null },
    ];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["b"]);
  });

  it("keeps a row that names itself as superseded visible", () => {
    expect(latestOnly([{ id: "a", supersedesId: "a", seq: 1 }]).map((r) => r.id)).toEqual(["a"]);
  });

  it("terminates on a cycle", () => {
    const rows = [
      { id: "x", supersedesId: null, seq: 1 },
      { id: "a", supersedesId: "b", seq: 2 },
      { id: "b", supersedesId: "a", seq: 3 },
    ];
    expect(latestOnly(rows).map((r) => r.id)).toEqual(["x"]);
  });
});

describe("earlierVersions", () => {
  const rows = [
    { id: "c", supersedesId: "b", seq: 3 },
    { id: "b", supersedesId: "a", seq: 2 },
    { id: "a", supersedesId: null, seq: 1 },
  ];

  it("walks a chain newest first, whatever the input order", () => {
    expect(earlierVersions(rows, rows[0]).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("stops at a missing parent, a self-reference or a cycle without repeats", () => {
    expect(earlierVersions([{ id: "b", supersedesId: "gone" }], { id: "b", supersedesId: "gone" })).toEqual([]);
    const self = { id: "a", supersedesId: "a" };
    expect(earlierVersions([self], self)).toEqual([]);
    const cyc = [
      { id: "a", supersedesId: "b" },
      { id: "b", supersedesId: "a" },
    ];
    expect(earlierVersions(cyc, cyc[0]).map((r) => r.id)).toEqual(["b"]);
  });
});
