/**
 * Helpers over tokenized SQL (sync/sql.ts), shared by lint's access analysis and the
 * claim reader: names, parentheses, top-level splits and fixed values.
 */

import type { Token } from "../sync/sql.ts";

export const word = (t: Token | undefined, w: string) => t?.kind === "word" && t.text === w;
export const sym = (t: Token | undefined, s: string) => t?.kind === "symbol" && t.text === s;
export const isName = (t: Token | undefined) => t?.kind === "word" || t?.kind === "quoted";

/** Index of the parenthesis closing the one opened at `open`, or -1. */
export function closing(t: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    if (sym(t[i], "(")) depth++;
    else if (sym(t[i], ")") && --depth === 0) return i;
  }
  return -1;
}

/** Indices of tokens at parenthesis depth 0. */
export function topLevel(t: Token[]): number[] {
  const out: number[] = [];
  let depth = 0;
  t.forEach((x, i) => {
    if (sym(x, "(")) depth++;
    else if (sym(x, ")")) depth--;
    else if (depth === 0) out.push(i);
  });
  return out;
}

export function splitTop(t: Token[], at: (x: Token) => boolean): Token[][] {
  const cuts = topLevel(t).filter((i) => at(t[i] as Token));
  const parts: Token[][] = [];
  let start = 0;
  for (const c of cuts) {
    parts.push(t.slice(start, c));
    start = c + 1;
  }
  parts.push(t.slice(start));
  return parts.filter((p) => p.length);
}

/** Without parentheses that wrap the whole expression. */
export function unwrap(t: Token[]): Token[] {
  let x = t;
  while (sym(x[0], "(") && closing(x, 0) === x.length - 1) x = x.slice(1, -1);
  return x;
}

export const LITERALS = new Set(["true", "false", "null"]);
/**
 * A fixed value: a side that names no column and reads no token or client value. 'a', 1,
 * true, ('a', 'b'), 'a'::text, CAST('a' AS text), lower('A'): its words are only literals,
 * function names, type names and CAST's AS.
 */
export function literal(side: Token[]): boolean {
  // A token or client read (auth.user_id()) has a name before a dot, which fails below.
  return (
    side.length > 0 &&
    side.every((t, i) => {
      if (t.kind === "quoted") return sym(side[i - 1], "::");
      if (t.kind !== "word") return true;
      return LITERALS.has(t.text) || t.text === "as" || sym(side[i + 1], "(") || sym(side[i - 1], "::") || word(side[i - 1], "as");
    })
  );
}
