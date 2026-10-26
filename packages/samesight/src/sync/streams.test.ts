import { describe, expect, it } from "vitest";
import { parseStreams } from "./streams.ts";

const streams = "config:\n  edition: 3\nstreams:\n  s:\n    auto_subscribe: true\n    query: SELECT * FROM lists\n";

describe("parseStreams", () => {
  it("refuses sections and keys it does not read, instead of skipping them", () => {
    expect(() => parseStreams(`${streams}bucket_definitions:\n  leak:\n    data:\n      - SELECT * FROM "Inspection"\n`)).toThrow(
      "the sync config has bucket_definitions, which this check does not read; only streams are supported",
    );
    expect(() => parseStreams("streams:\n  s:\n    data:\n      - SELECT 1\n")).toThrow("stream s has data, which this check does not read");
    expect(() => parseStreams("config:\n  edition: 3\n")).toThrow("no streams: section");
  });

  it("refuses malformed queries, and labels a single query by its key", () => {
    expect(() => parseStreams("streams:\n  s:\n    queries: SELECT 1\n")).toThrow("queries must be a list of SQL strings");
    expect(() => parseStreams("streams:\n  s:\n    query: [a]\n")).toThrow("query must be a SQL string");
    expect(() => parseStreams("streams:\n  s:\n    with:\n      c: [a]\n")).toThrow("with must map names to SQL strings");
    expect(parseStreams("streams:\n  s:\n    query: SELECT 1\n")[0]?.queries).toEqual([{ label: "query", sql: "SELECT 1" }]);
  });
});
