/**
 * Adding samesight's post-edit hook to an agent's hook settings (.claude/settings.json,
 * .codex/hooks.json) without touching what is there: the entry is appended to
 * hooks.PostToolUse, a file that already runs `samesight agent hook` is left as it is, and a
 * file that is not the JSON object expected is left alone, with the entry to add by hand.
 */

export interface HookEntry {
  matcher: string;
  hooks: { type: "command"; command: string; timeout: number }[];
}

export type MergeStatus = "create" | "update" | "unchanged" | "kept" | "skip";

export interface Merge {
  status: MergeStatus;
  /** The file's new text, for create and update. */
  text?: string;
  /** Why, for kept (the command already there) and skip (what is wrong with the file). */
  why?: string;
}

/** A hook command that runs samesight's hook, however it was written. */
const RUNS_HOOK = /\bsamesight\b.*\bagent\s+hook\b/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The indentation a JSON text uses (a tab, or 2 or 4 spaces), so a rewrite keeps it. */
function indentOf(text: string): string | number {
  const line = text.split("\n").find((l, i) => i > 0 && /^\s+\S/.test(l));
  if (!line) return 2;
  if (line.startsWith("\t")) return "\t";
  return (line.match(/^ +/)?.[0].length ?? 2) === 4 ? 4 : 2;
}

/** The settings text with samesight's hook added, or why it was not. `text` undefined: the file does not exist. */
export function mergeHook(text: string | undefined, entry: HookEntry): Merge {
  if (text === undefined || text.trim() === "") return { status: "create", text: `${JSON.stringify({ hooks: { PostToolUse: [entry] } }, null, 2)}\n` };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (e) {
    return { status: "skip", why: `it is not JSON samesight can read (${(e as Error).message})` };
  }
  if (!isObject(settings)) return { status: "skip", why: "it is not a JSON object" };
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return { status: "skip", why: "its hooks is not an object" };
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  if (hooks.PostToolUse !== undefined && !Array.isArray(hooks.PostToolUse)) return { status: "skip", why: "its hooks.PostToolUse is not a list" };
  const post = (hooks.PostToolUse ?? []) as unknown[];
  const commands = post.flatMap((g) => (isObject(g) && Array.isArray(g.hooks) ? g.hooks : [])).flatMap((h) => (isObject(h) && typeof h.command === "string" ? [h.command] : []));
  const ours = commands.find((c) => RUNS_HOOK.test(c));
  if (ours !== undefined) return ours === entry.hooks[0]?.command ? { status: "unchanged" } : { status: "kept", why: `it already runs ${ours}` };
  const next = { ...settings, hooks: { ...hooks, PostToolUse: [...post, entry] } };
  return { status: "update", text: `${JSON.stringify(next, null, indentOf(text))}${text.endsWith("\n") ? "\n" : ""}` };
}
