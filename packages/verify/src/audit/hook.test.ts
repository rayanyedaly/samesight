import { describe, expect, it } from "vitest";
import { executeAdvice, parseHookUri, SELECTS_ALL, scanBody, scanDeep, showUri, starredTables, unfollowed } from "./hook.ts";

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
    // Each scan keeps its body and the calls that led to it: the columns a helper names count as read.
    expect(scanDeep("select private.lead_of(uid)", functions).map((s) => [s.via, s.body])).toEqual([
      [[], "select private.lead_of(uid)"],
      [["private.lead_of"], "select public.team_of(u) from public.teams"],
      [["private.lead_of", "public.team_of"], "select team_id from public.memberships where user_id = u"],
    ]);
  });

  it("lists the calls past the last level that run a body of their own, and only those", () => {
    const functions = new Map([
      ["public.team_of", "select team_id from public.memberships where user_id = u"],
      ["private.lead_of", "select public.team_of(u) from public.teams"],
      ["private.deep", "select private.lead_of(u), now() from public.deepest"],
      ["private.deeper", "select private.deep(u)"],
    ]);
    expect(unfollowed(scanDeep("select private.deeper(uid)", functions), functions)).toEqual(["private.lead_of"]);
    // team_of is two levels down, and calls nothing with a body.
    expect(unfollowed(scanDeep("select private.lead_of(uid)", functions), functions)).toEqual([]);
    // A call already followed nearer the hook is no deeper read.
    expect(unfollowed(scanDeep("select private.deeper(uid), private.lead_of(uid)", functions), functions)).toEqual([]);
    // Named bare, a body already scanned under its qualified name.
    const bare = new Map([...functions, ["team_of", "select team_id from public.memberships where user_id = u"], ["private.deep", "select team_of(u) from public.deepest"]]);
    expect(unfollowed(scanDeep("select private.deeper(uid), public.team_of(uid)", bare), bare)).toEqual([]);
  });

  it("names the tables a statement with select * reads, and not those of the body's other statements", () => {
    expect(starredTables("select * from settings; select team_id from public.memberships")).toEqual(["public.settings"]);
    expect(starredTables("select * into r from public.memberships where user_id = uid; return to_jsonb(r)")).toEqual(["public.memberships"]);
    expect(starredTables(`select t.* from members m join only "Teams" t using (id)`)).toEqual(["public.members", "public.Teams"]);
    expect(starredTables("select *, 1 as x from a, b")).toEqual(["public.a", "public.b"]);
    expect(starredTables("select 1 from t where exists (select * from public.memberships)")).toEqual([]);
  });

  it("judges each select by its own list, past guards and loop bodies", () => {
    // A guard before the select reads no columns of its own table.
    expect(starredTables("if exists (select 1 from flags) then select * into r from memberships where user_id = u; end if")).toEqual(["public.memberships"]);
    expect(starredTables("if exists (select * from flags) then select team_id into t from memberships; end if")).toEqual([]);
    // A loop's body is not the select's.
    expect(starredTables("for r in select * from teams loop insert into log select role from memberships; end loop")).toEqual(["public.teams"]);
    expect(starredTables("select m.role, t.* into r from memberships m join teams t using (team_id)")).toEqual(["public.memberships", "public.teams"]);
    expect(starredTables("select distinct * from memberships")).toEqual(["public.memberships"]);
    expect(starredTables("select distinct on (team_id) * from memberships")).toEqual(["public.memberships"]);
    // A whole row of a table it reads, but not of a variable.
    expect(starredTables("select to_jsonb(m) into j from memberships m where m.user_id = u")).toEqual(["public.memberships"]);
    expect(starredTables("select row_to_json(memberships) from memberships")).toEqual(["public.memberships"]);
    expect(starredTables("select to_jsonb(n) into j from memberships m")).toEqual([]);
    expect(starredTables("select count(*) from memberships")).toEqual([]);
    expect(starredTables("select to_json(m) from memberships m")).toEqual(["public.memberships"]);
    expect(starredTables("select hstore(m) from memberships m")).toEqual(["public.memberships"]);
    expect(starredTables("select all * from memberships")).toEqual(["public.memberships"]);
    // No space before from.
    expect(starredTables("select *from public.profiles into r")).toEqual(["public.profiles"]);
    expect(starredTables("select t.*from teams t")).toEqual(["public.teams"]);
    // A column named from, after a dot, is no from.
    expect(starredTables("select t.from, t.* from teams t")).toEqual(["public.teams"]);
  });

  it("takes select * as reading every column, but not exists (select * ...)", () => {
    expect(["select * from t", "select m.* from t m", "SELECT\n*", "exists (select * from t)", "EXISTS(SELECT * FROM t)"].map((x) => SELECTS_ALL.test(x))).toEqual([true, true, true, false, false]);
  });
});

describe("executeAdvice", () => {
  it("gives the grants and the revoke Supabase's guide runs, with names quoted as SQL needs them", () => {
    const advice = executeAdvice(["anon", "authenticated"], "pg-functions://postgres/Auth/MyHook", "Auth", "MyHook");
    expect(advice).toMatch(/^anon, authenticated can execute the access token hook pg-functions:\/\/postgres\/Auth\/MyHook /);
    expect(advice).toContain('grant usage on schema "Auth" to supabase_auth_admin; grant execute on function "Auth"."MyHook"(jsonb) to supabase_auth_admin; revoke execute on function "Auth"."MyHook"(jsonb) from public, anon, authenticated');
    expect(executeAdvice(["anon"], "x", "public", "custom_access_token_hook")).toContain("public.custom_access_token_hook(jsonb)");
  });
});
