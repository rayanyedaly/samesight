import { describe, expect, it } from "vitest";
import { classifyUploadError } from "./errors";

// The write-path table: what the connector does with each kind of failed apply_batch.
describe("classifyUploadError", () => {
  it.each([
    [401, null],
    [401, "PGRST303"],
    [400, "PGRST301"],
    [401, "28000"], // token without a tenant: a refreshed one may carry it
  ])("re-authenticates on an expired or invalid session (%i %s)", (status, code) => {
    expect(classifyUploadError({ status, code })).toBe("reauth");
  });

  it.each([
    [0, null], // network failure
    [500, null],
    [502, null],
    [503, null],
    [408, null],
    [425, null],
    [429, null],
    [500, "57014"], // statement timeout
    [500, "40001"], // serialization failure
    [500, "40P01"], // deadlock
    [503, "08006"], // connection failure
    [503, "53300"], // too many connections
  ])("retries temporary failures (%i %s)", (status, code) => {
    expect(classifyUploadError({ status, code })).toBe("retry");
  });

  it.each([
    [400, "22P02"], // invalid uuid
    [400, "23514"], // check violation
    [409, "23503"], // foreign key
    [409, "23505"], // unique
    [403, "42501"], // RLS
    [400, "P0001"], // refused by apply_batch
    [422, "PGRST204"], // a column the schema cache does not know
  ])("rejects what can never succeed (%i %s)", (status, code) => {
    expect(classifyUploadError({ status, code })).toBe("reject");
  });

  it("classifies by Postgres code before HTTP status", () => {
    // A serialization failure stays temporary whatever status PostgREST maps it to.
    expect(classifyUploadError({ status: 409, code: "40001" })).toBe("retry");
  });

  it.each([
    [413, null], // batch too large: a person decides
    [404, "PGRST202"], // apply_batch missing: the server is not set up
    [404, null],
    [400, "SS001"], // apply_batch does not know this table or op
    [400, "42703"], // undefined column: SQL drifted from the schema
    [400, "42P10"], // no unique constraint for ON CONFLICT
    [405, "25006"], // read-only database
    [403, null], // a proxy or firewall, not PostgREST
    [422, null],
  ])("holds the batch instead of dropping it (%i %s)", (status, code) => {
    expect(classifyUploadError({ status, code })).toBe("stuck");
  });
});
