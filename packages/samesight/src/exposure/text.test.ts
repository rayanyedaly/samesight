import { describe, expect, it } from "vitest";
import { named, safe } from "./text.ts";

describe("named", () => {
  it("leaves a plain name as it is", () => {
    for (const name of ["lists", "Tenant", "with.my_orgs", "sync-config.yaml", "origin/main", "HEAD~1", "café"]) expect(named(name), name).toBe(name);
  });

  it("quotes any other name, escaping quotes, backslashes and every character that could move or hide text", () => {
    expect(named('a"b')).toBe('"a\\"b"');
    expect(named("a\\b")).toBe('"a\\\\b"');
    expect(named("a\nb\rc\td")).toBe('"a\\nb\\rc\\td"');
    expect(named("\u001b[31mred")).toBe('"\\u001b[31mred"');
    expect(named("x\u0085::warning::y")).toBe('"x\\u0085::warning::y"');
    expect(named("a‮b")).toBe('"a\\u202eb"');
    expect(named("a b")).toBe('"a\\u2028b"');
    expect(named("::error::x")).toBe('"::error::x"');
    expect(named("")).toBe('""');
  });
});

describe("safe", () => {
  it("puts control, format and separator characters as spaces, and leaves the rest", () => {
    expect(safe("a\nb\r\nc")).toBe("a b c");
    expect(safe("x\u0085y z‮w\u007fv")).toBe("x y z w v");
    expect(safe("plain  text, two spaces")).toBe("plain  text, two spaces");
  });
});
