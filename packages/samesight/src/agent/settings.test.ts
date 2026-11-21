import { describe, expect, it } from "vitest";
import { type HookEntry, mergeHook } from "./settings.ts";

const entry: HookEntry = { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: "npx --no-install samesight agent hook", timeout: 30 }] };

describe("mergeHook", () => {
  it("creates the settings when there are none", () => {
    for (const text of [undefined, "", "  \n"]) {
      const merge = mergeHook(text, entry);
      expect(merge.status).toBe("create");
      expect(JSON.parse(merge.text as string)).toEqual({ hooks: { PostToolUse: [entry] } });
      expect(merge.text?.endsWith("}\n")).toBe(true);
    }
  });

  it("appends the entry and keeps everything else, with the file's indentation and final newline", () => {
    const settings = { permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }], PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }] } };
    for (const indent of [2, 4, "\t"]) {
      for (const newline of ["\n", ""]) {
        const text = `${JSON.stringify(settings, null, indent)}${newline}`;
        const merge = mergeHook(text, entry);
        expect(merge.status).toBe("update");
        expect(JSON.parse(merge.text as string)).toEqual({ ...settings, hooks: { ...settings.hooks, PostToolUse: [...settings.hooks.PostToolUse, entry] } });
        expect(merge.text).toBe(`${JSON.stringify(JSON.parse(merge.text as string), null, indent)}${newline}`);
      }
    }
    expect(JSON.parse(mergeHook('{"model": "x"}', entry).text as string)).toEqual({ model: "x", hooks: { PostToolUse: [entry] } });
  });

  it("leaves a file that already runs samesight's hook as it is, however the command is written", () => {
    const has = (command: string) => JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command }] }] } });
    expect(mergeHook(has("npx --no-install samesight agent hook"), entry)).toEqual({ status: "unchanged" });
    expect(mergeHook(has("pnpm exec samesight agent hook app/sync.yaml"), entry)).toEqual({ status: "kept", why: "it already runs pnpm exec samesight agent hook app/sync.yaml" });
    // A second run writes nothing.
    const once = mergeHook(undefined, entry).text as string;
    expect(mergeHook(once, entry)).toEqual({ status: "unchanged" });
  });

  it("leaves a file it cannot read, or of another shape, alone, saying why", () => {
    expect(mergeHook("{ // comment\n}", entry)).toEqual({ status: "skip", why: expect.stringMatching(/^it is not JSON samesight can read \(/) });
    expect(mergeHook("[]", entry)).toEqual({ status: "skip", why: "it is not a JSON object" });
    expect(mergeHook('{"hooks": []}', entry)).toEqual({ status: "skip", why: "its hooks is not an object" });
    expect(mergeHook('{"hooks": {"PostToolUse": {}}}', entry)).toEqual({ status: "skip", why: "its hooks.PostToolUse is not a list" });
  });
});
