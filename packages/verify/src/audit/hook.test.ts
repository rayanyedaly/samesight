import { describe, expect, it } from "vitest";
import { parseHookUri, scanBody, scanDeep, showUri } from "./hook.ts";

describe("parseHookUri", () => {
  it("reads a pg-functions URI, and tells an HTTP hook from one audit does not read", () => {
    expect(parseHookUri("pg-functions://postgres/public/custom_access_token_hook")).toEqual({ kind: "function", schema: "public", fn: "custom_access_token_hook" });
    expect(parseHookUri("https://hooks.example.com/token")).toEqual({ kind: "remote" });
    expect(parseHookUri("pg-functions://postgres/public")).toEqual({ kind: "unknown" });
  });

  it("prints an HTTP hook without its user, password, query or fragment", () => {
    expect(showUri("https://user:secret@hooks.example.com/token?key=abc#x")).toBe("https://hooks.example.com/token");
    expect(showUri("pg-functions://postgres/public/hook")).toBe("pg-functions://postgres/public/hook");
  });
});

describe("scanBody", () => {
  const hook = `
    declare m record; claims jsonb;
    begin
      -- from public.decoy is a comment
      select team_id, role into m from public.memberships where user_id = (event->>'user_id')::uuid;
      perform 1 from teams t join public.orgs o on o.id = t.org_id;
      select x from json_each(event->'claims') j;
      claims := jsonb_set(event->'claims', '{team_role}', to_jsonb(m.role));
      raise log 'select * from strings';
      return jsonb_build_object('claims', claims);
    end`;

  it("finds the tables a body reads after FROM and JOIN, comments, strings and functions aside", () => {
    expect(scanBody(hook)).toEqual({ reads: ["public.memberships", "public.teams", "public.orgs"], writes: [], calls: expect.arrayContaining(["jsonb_set", "json_each"]), dynamic: false, metadataWrites: [] });
  });

  it("tells writes, dynamic SQL and metadata set in the claims from reads", () => {
    const s = scanBody(`
      insert into public.audit_log (user_id) values ((event->>'user_id')::uuid);
      update counters set n = n + 1;
      delete from public.sessions_seen where true;
      select 1 from memberships for update;
      execute format('select 1 from %I', 'x');
      claims := jsonb_set(claims, '{app_metadata,role}', '"admin"');
      claims := claims || jsonb_build_object('user_metadata', '{}'::jsonb);
      event := jsonb_set(event, '{claims,app_metadata,tier}', '"gold"');`);
    expect(s.writes).toEqual(["public.audit_log", "public.counters", "public.sessions_seen"]);
    expect(s.reads).toEqual(["public.memberships"]);
    expect(s.dynamic).toBe(true);
    expect(s.metadataWrites).toEqual(["app_metadata.role", "app_metadata.tier", "user_metadata"]);
  });

  it("keeps a quoted name's case and reads a quoted schema", () => {
    expect(scanBody(`select 1 from "Teams" join "private"."Members" using (id)`).reads).toEqual(["public.Teams", "private.Members"]);
  });
});

describe("scanDeep", () => {
  it("follows the functions a body calls two levels deep, and no further", () => {
    const functions = new Map([
      ["public.team_of", "select team_id from public.memberships where user_id = u"],
      ["team_of", "select team_id from public.memberships where user_id = u"],
      ["private.lead_of", "select public.team_of(u) from public.teams"],
      ["private.deep", "select private.lead_of(u) from public.deepest"],
      ["private.deeper", "select private.deep(u)"],
    ]);
    const reads = (body: string) => scanDeep(body, functions).flatMap((s) => s.reads);
    expect(reads("select private.lead_of(uid)")).toEqual(["public.teams", "public.memberships"]);
    expect(reads("select team_of(uid)")).toEqual(["public.memberships"]);
    expect(reads("select private.deeper(uid)")).toEqual(["public.deepest"]);
  });
});
