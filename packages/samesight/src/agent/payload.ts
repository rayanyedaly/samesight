/**
 * The files an agent's edit touched, read from the JSON its hook receives on stdin. Claude
 * Code (and Cursor, which runs Claude Code's hooks) puts the path in tool_input.file_path;
 * Codex's apply_patch puts it in the patch text. Anything else counts by the paths it
 * mentions, so a shape this does not know costs nothing but a lint it could have skipped.
 */

export interface Edit {
  /** Paths the edit wrote, as the payload gives them (absolute or relative to `cwd`). */
  paths: string[];
  /** Every string in tool_input, for a payload that names no path: a shell command, say. */
  texts: string[];
  /** The directory the agent ran in, when the payload says. */
  cwd?: string;
  /** The hook event, when the payload says. */
  event?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Patch headers naming a file: `*** Add File: a.yaml`, `*** Update File: b.sql`, `*** Delete File: c`, `*** Move to: d`. */
const PATCH_FILE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm;

/** The strings in a value, depth first, a few levels down: a patch may sit in tool_input.input or in tool_input.command[1]. */
function strings(v: unknown, depth = 0): string[] {
  if (typeof v === "string") return [v];
  if (depth >= 4) return [];
  if (Array.isArray(v)) return v.flatMap((x) => strings(x, depth + 1));
  if (isObject(v)) return Object.values(v).flatMap((x) => strings(x, depth + 1));
  return [];
}

/** What a hook payload says was edited, or undefined when it is not a JSON object. */
export function readEdit(text: string): Edit | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(payload)) return undefined;
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const response = isObject(payload.tool_response) ? payload.tool_response : {};
  const texts = strings(input);
  const named = [input.file_path, input.path, input.notebook_path, response.filePath].filter((p): p is string => typeof p === "string" && p !== "");
  const patched = texts.flatMap((t) => [...t.matchAll(PATCH_FILE)].map((m) => m[1] as string));
  return {
    paths: [...new Set([...named, ...patched])],
    texts,
    ...(typeof payload.cwd === "string" && payload.cwd ? { cwd: payload.cwd } : {}),
    ...(typeof payload.hook_event_name === "string" ? { event: payload.hook_event_name } : {}),
  };
}
