import { describe, expect, it } from "vitest";
import { parseHookUri, scanBody, scanDeep, showUri } from "./hook.ts";

describe("parseHookUri", () => {
  it("reads a pg-functions URI, and tells an HTTP hook from one audit does not read", () => {
    expect(parseHookUri("pg-functions://postgres/public/custom_access_token_hook")).toEqual({ kind: "function", schema: "public", fn: "custom_access_token_hook" });
    expect(parseHookUri("https://hooks.example.com/token")).toEqual({ kind: "remote" });
    expect(parseHookUri("pg-functions://postgres/public")).toEqual({ kind: "unknown" });
  });

  it("prints an HTTP hook as its host, since its user, password, path or query may hold a secret", () => {
    expect(showUri("https://user:secret@hooks.example.com/token/abc123?key=abc#x")).toBe("https://hooks.example.com/...");
    expect(showUri(" https://u:pw@hooks.example.com/ ")).toBe("https://hooks.example.com");
    expect(showUri("pg-functions://postgres/public/hook")).toBe("pg-functions://postgres/public/hook");
    expect(showUri("postgres://user:secret@db/x")).toBe("postgres:...");
    expect(showUri("not a uri")).toBe("(a hook uri audit does not read)");
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
    expect(scanBody(hook)).toEqual({ reads: ["public.memberships", "public.teams", "public.orgs"], writes: [], calls: ["json_each", "jsonb_set", "to_jsonb", "jsonb_build_object"], dynamic: false, metadataWrites: [] });
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

  it("reads every table of a comma list, USING, and a table read and written", () => {
    const s = scanBody(`
      select m.role into r from public.memberships m, public.teams t, lateral (select 1) x, public.never where m.team_id = t.id;
      delete from public.seen s using public.orgs o where s.org = o.id;
      update public.profiles set last_sign_in = now() where id = uid;
      select role into r from public.profiles where id = uid;
      insert into http_log (at) values (now());
      perform extensions.dblink_exec('x', 'y');
      perform pg_catalog.pg_notify('c', 'p');`);
    expect(s.reads).toEqual(["public.memberships", "public.teams", "public.profiles", "public.orgs"]);
    expect(s.writes).toEqual(["public.http_log", "public.profiles", "public.seen"]);
    expect(s.calls).not.toContain("http_log");
    expect(s.calls).toEqual(["now", "extensions.dblink_exec", "pg_catalog.pg_notify"]);
  });

  it("tells metadata set in the token from metadata read", () => {
    expect(
      scanBody(`
        r := event #>> '{claims,app_metadata,role}';
        x := event->'claims'->'app_metadata';
        y := jsonb_set(x, '{a}', event->'claims'->'app_metadata', true);`).metadataWrites,
    ).toEqual([]);
    expect(
      scanBody(`
        claims := jsonb_set(coalesce(claims, '{}'), '{app_metadata,tier}', '"gold"');
        claims := claims || jsonb_build_object('at', now(), 'user_metadata', x);
        claims := claims || '{"app_metadata": {}}'::jsonb;`).metadataWrites,
    ).toEqual(["app_metadata.tier", "app_metadata", "user_metadata"]);
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
