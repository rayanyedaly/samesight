/**
 * Text from the files or a commit (names, labels, link targets, SQL) as it may be printed:
 * on one line, and never able to pose as a line of the tool's own or a CI runner's command
 * (which starts a line with ::), nor to move the cursor or reorder what a terminal shows.
 */

/** Characters that end a line, move the terminal, or reorder text: C0 and C1 controls, DEL, line and paragraph separators, and format characters (bidi overrides among them). */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const UNSAFE_ALL = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

/** Text put on the line it is printed in: every unsafe character as a space. */
export const safe = (text: string) => text.replace(UNSAFE_ALL, " ");

/**
 * A name as it is when it is a plain name, else in double quotes with every unsafe character,
 * quote and backslash escaped: a name that could start a line, or hide what it holds, shows it.
 */
export function named(name: string): string {
  if (/^[\p{L}\p{N}_$][\p{L}\p{N}_$./@~^-]*$/u.test(name) && !UNSAFE.test(name)) return name;
  const escaped = [...name]
    .map((ch) => {
      if (ch === '"' || ch === "\\") return `\\${ch}`;
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      if (ch === "\t") return "\\t";
      if (UNSAFE.test(ch)) return `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
      return ch;
    })
    .join("");
  return `"${escaped}"`;
}
