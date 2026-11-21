import { describe, expect, it } from "vitest";
import { readEdit } from "./payload.ts";

describe("readEdit", () => {
  it("reads the path Claude Code's Write, Edit, MultiEdit and NotebookEdit give, and the cwd and event", () => {
    const claude = (tool: string, input: object) => readEdit(JSON.stringify({ session_id: "s", cwd: "/p", hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: {} }));
    expect(claude("Write", { file_path: "/p/sync-config.yaml", content: "x" })).toEqual({ paths: ["/p/sync-config.yaml"], texts: ["/p/sync-config.yaml", "x"], cwd: "/p", event: "PostToolUse" });
    expect(claude("Edit", { file_path: "/p/a.sql", old_string: "a", new_string: "b" })?.paths).toEqual(["/p/a.sql"]);
    expect(claude("MultiEdit", { file_path: "/p/a.sql", edits: [{ old_string: "a", new_string: "b" }] })?.paths).toEqual(["/p/a.sql"]);
    expect(claude("NotebookEdit", { notebook_path: "/p/n.ipynb", new_source: "x" })?.paths).toEqual(["/p/n.ipynb"]);
    // The response's path counts too, once.
    expect(readEdit(JSON.stringify({ tool_input: { file_path: "/p/a.sql" }, tool_response: { filePath: "/p/a.sql" } }))?.paths).toEqual(["/p/a.sql"]);
  });

  it("reads the files a Codex apply_patch names, in its input or its command", () => {
    const patch = "*** Begin Patch\n*** Update File: powersync/sync-config.yaml\n@@\n-a\n+b\n*** Add File: supabase/migrations/2_x.sql\n+create table x ();\n*** Delete File: old.yaml\n*** Update File: a.yaml\n*** Move to: b.yaml\n*** End Patch\n";
    const files = ["powersync/sync-config.yaml", "supabase/migrations/2_x.sql", "old.yaml", "a.yaml", "b.yaml"];
    expect(readEdit(JSON.stringify({ tool_name: "apply_patch", tool_input: { input: patch } }))?.paths).toEqual(files);
    expect(readEdit(JSON.stringify({ tool_name: "shell", tool_input: { command: ["apply_patch", patch] } }))?.paths).toEqual(files);
  });

  it("keeps every string of a payload that names no file, for the paths it mentions", () => {
    expect(readEdit(JSON.stringify({ tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ powersync/sync-config.yaml", description: "edit" } }))).toEqual({
      paths: [],
      texts: ["sed -i s/a/b/ powersync/sync-config.yaml", "edit"],
    });
  });

  it("is undefined for what is not a JSON object, and empty for an object with no tool_input", () => {
    for (const text of ["", "not json", "[1]", "null", '"x"']) expect(readEdit(text), text).toBeUndefined();
    expect(readEdit(JSON.stringify({ tool_input: "x", cwd: 3 }))).toEqual({ paths: [], texts: [] });
  });
});
