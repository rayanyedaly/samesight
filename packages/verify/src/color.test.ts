import { describe, expect, it } from "vitest";
import { useColor } from "./color.ts";

describe("useColor", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it("colours a terminal and nothing else", () => {
    expect(useColor(tty, {})).toBe(true);
    expect(useColor(pipe, {})).toBe(false);
    expect(useColor({}, {})).toBe(false);
  });

  it("is off under NO_COLOR, whatever else says", () => {
    expect(useColor(tty, { NO_COLOR: "1" })).toBe(false);
    expect(useColor(tty, { NO_COLOR: "0", FORCE_COLOR: "1" })).toBe(false);
    // An empty NO_COLOR is no NO_COLOR.
    expect(useColor(tty, { NO_COLOR: "" })).toBe(true);
  });

  it("is on under FORCE_COLOR, piped or in CI, and off under FORCE_COLOR=0 or false", () => {
    expect(useColor(pipe, { FORCE_COLOR: "1" })).toBe(true);
    expect(useColor(pipe, { FORCE_COLOR: "3", CI: "true", TERM: "dumb" })).toBe(true);
    expect(useColor(tty, { FORCE_COLOR: "0" })).toBe(false);
    expect(useColor(tty, { FORCE_COLOR: "false" })).toBe(false);
    expect(useColor(pipe, { FORCE_COLOR: "" })).toBe(false);
    expect(useColor(tty, { FORCE_COLOR: "" })).toBe(true);
  });

  it("is off in CI and in a dumb terminal", () => {
    expect(useColor(tty, { CI: "true" })).toBe(false);
    expect(useColor(tty, { TERM: "dumb" })).toBe(false);
    expect(useColor(tty, { TERM: "xterm-256color" })).toBe(true);
  });
});
