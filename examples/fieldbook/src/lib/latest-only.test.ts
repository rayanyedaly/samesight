import { describe, expect, it } from "vitest";
import { type Finding, findingChains } from "./latest-only";

const finding = (id: string, supersedesId: string | null = null, seq: number | null = null): Finding =>
  ({ id, supersedesId, seq, body: id, severity: "LOW" }) as Finding;

const view = (findings: Finding[]) =>
  findingChains(findings).map((c) => [c.latest.id, c.earlier.map((f) => f.id)]);

describe("findingChains", () => {
  it("shows the current row of each chain with its history, newest first", () => {
    expect(view([finding("x", null, 1), finding("a", null, 2), finding("b", "a", 3), finding("c", "b", 4)])).toEqual([
      ["x", []],
      ["c", ["b", "a"]],
    ]);
  });

  it("shows one current row when two devices amend the same finding: the last applied", () => {
    expect(view([finding("a", null, 1), finding("b", "a", 5), finding("c", "a", 4)])).toEqual([["b", ["a"]]]);
  });

  it("puts a local amendment that has not synced yet (no seq) on top", () => {
    expect(view([finding("a", null, 1), finding("b", "a", 5), finding("c", "a")])).toEqual([["c", ["a"]]]);
  });
});
