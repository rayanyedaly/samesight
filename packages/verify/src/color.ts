/**
 * Whether output to `stream` gets colour: never under NO_COLOR (any value), always under
 * FORCE_COLOR, never under FORCE_COLOR=0 or false (as Node reads it), never in CI or a dumb
 * terminal, else only in a terminal. Empty values count as unset.
 */
export function useColor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.CI || env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;

export const red = sgr(31, 39);
export const yellow = sgr(33, 39);
export const green = sgr(32, 39);
export const dim = sgr(2, 22);
