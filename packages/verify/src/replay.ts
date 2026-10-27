/** A word as a POSIX shell reads it back: as is when it is plain, else in single quotes. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Flags a replay drops: the seed it sets itself, and output flags that would only write the report again. */
const DROPPED = ["--seed", "--json", "--report"];
/** Those that take a value as the next argument. */
const VALUED = new Set(["--seed", "--report"]);

/**
 * The command that replays a run: its own arguments (those after `audit` in audit mode) less
 * `--seed`, `--json` and `--report`, then `--seed <seed>`, each quoted for a shell.
 */
export function replayCommand(mode: "policy" | "audit", argv: string[], seed: number): string {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const name = a.split("=")[0] as string;
    if (!DROPPED.includes(name)) kept.push(a);
    else if (name === a && VALUED.has(a)) i++;
  }
  return ["samesight-verify", ...(mode === "audit" ? ["audit"] : []), ...kept, "--seed", String(seed)].map(shellQuote).join(" ");
}
