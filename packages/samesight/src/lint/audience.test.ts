import { describe, expect, it } from "vitest";
import { corpusFiles } from "../fixtures/corpus.ts";
import { parseSyncConfig } from "../sync/config.ts";
import { AUDIENCE_ORDER, type Audience, audienceText, bucketAudiences, streamAudience, widest } from "./audience.ts";
import { type LintRule, lineFinder, lintSyncConfig } from "./lint.ts";
import { clientScoped } from "./rules/client-scoped.ts";
import { unscopedQuery } from "./rules/unscoped-query.ts";

type Keys = (table: string) => string[] | undefined;

const stream = (sql: string, ctes: Record<string, string> = {}, keys?: Keys) => streamAudience(sql, new Map(Object.entries(ctes)), keys);
const docs = (where: string, ctes: Record<string, string> = {}) => stream(`SELECT * FROM docs WHERE ${where}`, ctes);

/** Each data query's audience through each parameter query, in order. */
function bucket(parameters: string[], data: string[], keys?: Keys): Record<string, Audience[]> {
  const out = bucketAudiences(new Map(parameters.map((sql, n) => [`parameters[${n}]`, sql])), data.map((sql, n) => ({ label: `data[${n}]`, sql })), keys);
  return Object.fromEntries([...out].map(([label, entries]) => [label, entries.map((e) => e.audience)]));
}

const owner = (column: string, parent?: { table: string; column: string }): Audience => (parent ? { kind: "owner", column, parent } : { kind: "owner", column });
const group = (via: string): Audience => ({ kind: "group", via });
const role: Audience = { kind: "role" };
const fixed: Audience = { kind: "fixed" };
const client: Audience = { kind: "client" };
const everyone: Audience = { kind: "everyone" };
const mixed: Audience = { kind: "everyone", mixed: true };

describe("stream queries sent to their owner", () => {
  it("compare the user id with a column of the row, however written", () => {
    expect(stream("SELECT * FROM lists WHERE owner_id = auth.user_id()")).toEqual(owner("owner_id"));
    expect(stream("SELECT * FROM profiles WHERE id = auth.user_id()")).toEqual(owner("id"));
    for (const sql of [
      "SELECT * FROM lists WHERE auth.user_id() = owner_id",
      "SELECT * FROM lists l WHERE l.owner_id = auth.user_id()",
      "SELECT * FROM public.lists WHERE lists.owner_id = auth.user_id()",
      "SELECT * FROM Lists WHERE (OWNER_ID = Auth.User_Id())",
      "SELECT * FROM lists WHERE owner_id=auth.user_id ( ) -- mine",
      "SELECT * FROM lists WHERE owner_id = (auth.user_id())::text",
      "SELECT * FROM lists WHERE owner_id = auth.parameter('sub')",
      "SELECT * FROM lists WHERE owner_id = auth.parameters() ->> 'sub'",
      "SELECT * FROM lists WHERE owner_id = request.user_id()",
      "SELECT * FROM lists WHERE owner_id = token_parameters.user_id",
      "SELECT * FROM lists WHERE owner_id = auth.user_id() AND status = 'open'",
      "SELECT * FROM lists WHERE owner_id = auth.user_id() AND org_id IN (SELECT org_id FROM members WHERE user_id = auth.user_id())",
      "SELECT * FROM lists WHERE owner_id = auth.user_id() OR owner_id = auth.user_id()",
    ]) {
      expect(stream(sql), sql).toEqual(owner("owner_id"));
    }
    // Quoted names keep their case, as Postgres resolves them.
    expect(stream(`SELECT * FROM "Lists" WHERE "ownerId" = auth.user_id()`)).toEqual(owner("ownerId"));
  });

  it("compare it with a column of the one parent row a join reaches by key", () => {
    const parent = owner("list_id", { table: "lists", column: "owner_id" });
    for (const sql of [
      "SELECT todos.* FROM todos INNER JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()",
      "SELECT todos.* FROM todos JOIN lists ON lists.id = todos.list_id AND lists.owner_id = auth.user_id()",
      "SELECT t.* FROM todos t JOIN lists l ON (t.list_id = l.id) WHERE l.owner_id = auth.user_id() AND t.done = false",
      "SELECT todos.* FROM lists JOIN todos ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()",
    ]) {
      expect(stream(sql), sql).toEqual(parent);
    }
    // The key comes from the migrations when known.
    const keys: Keys = (t) => (t === "lists" ? ["uuid"] : undefined);
    expect(stream("SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.uuid WHERE lists.owner_id = auth.user_id()", {}, keys)).toEqual(parent);
    // A parent whose owner column is its key holds the user id in the row's own column; a row
    // joined to itself by key is owned by its own column.
    expect(stream("SELECT todos.* FROM todos JOIN users ON todos.owner_id = users.id WHERE users.id = auth.user_id()")).toEqual(owner("owner_id"));
    expect(stream("SELECT a.* FROM lists a JOIN lists b ON a.id = b.id WHERE b.owner_id = auth.user_id()")).toEqual(owner("owner_id"));
    expect(stream("SELECT a.* FROM lists a JOIN lists b ON a.parent_id = b.id WHERE b.owner_id = auth.user_id()")).toEqual(owner("parent_id", { table: "lists", column: "owner_id" }));
  });

  it("pick the row from the keys of the user's own parent rows, by subquery or CTE", () => {
    const parent = owner("list_id", { table: "lists", column: "owner_id" });
    for (const set of [
      "(SELECT id FROM lists WHERE owner_id = auth.user_id())",
      "(SELECT DISTINCT lists.id AS list_id FROM public.lists WHERE lists.owner_id = auth.user_id() AND archived = false)",
      "(SELECT l.id FROM lists l WHERE l.owner_id = auth.user_id() OR l.owner_id = auth.user_id())",
      "(SELECT id FROM lists WHERE owner_id = auth.user_id() ORDER BY id LIMIT 10)",
    ]) {
      expect(stream(`SELECT * FROM todos WHERE list_id IN ${set}`), set).toEqual(parent);
    }
    expect(stream("SELECT * FROM todos WHERE list_id IN mine", { mine: "SELECT id FROM lists WHERE owner_id = auth.user_id()" })).toEqual(parent);
    expect(stream(`SELECT * FROM todos WHERE todos.list_id IN "Mine"`, { Mine: "SELECT id FROM lists WHERE owner_id = auth.user_id()" })).toEqual(parent);
    expect(stream("SELECT * FROM lists WHERE id IN (SELECT id FROM lists WHERE owner_id = auth.user_id())")).toEqual(owner("owner_id"));
    expect(stream("SELECT * FROM todos WHERE list_id IN (SELECT uuid FROM lists WHERE owner_id = auth.user_id())", {}, () => ["uuid"])).toEqual(parent);
  });
});

describe("a token read mixed into more than the comparison", () => {
  it("ties no row, so the audience is every user, never a group or owner", () => {
    for (const where of [
      "owner_id IN (auth.user_id(), 'system')",
      "owner_id = auth.user_id() IS NULL",
      "owner_id = auth.user_id() IS NOT TRUE",
      "owner_id = auth.user_id() ISNULL",
      "owner_id = auth.user_id() NOTNULL",
      "owner_id = CASE WHEN kind = 'pub' THEN 'shared' ELSE auth.user_id() END",
      "auth.user_id() IN (owner_id, 'x')",
      // A column beside the token in a list: the rows where owner_id = editor_id reach every user.
      "owner_id IN (auth.user_id(), editor_id)",
      "org_id IN (auth.parameter('org_id'), org_id)",
      // A fallback for a claim a token may lack, or a column beside the token.
      "org_id = coalesce(auth.parameter('org_id'), 'public')",
      "org_id = COALESCE(auth.parameter('org_id'), org_id)",
      "org_id IN coalesce(auth.parameter('org_ids'), '[\"public\"]')",
      // The comparison is a truth value compared again.
      "(owner_id = auth.user_id()) = is_done",
      "owner_id = (auth.user_id() IS NULL)",
      "org_id IN (SELECT org_id FROM memberships WHERE user_id IN (auth.user_id(), 'x'))",
      "org_id IN (SELECT org_id FROM memberships WHERE active AND user_id IN (auth.user_id(), 'x'))",
    ]) {
      expect(docs(where), where).toEqual(mixed);
    }
    // The token compared with itself limits nothing, as unscoped-query sees it.
    expect(docs("auth.user_id() IN (auth.user_id(), owner_id)")).toEqual(everyone);
    expect(docs("org_id IN mine", { mine: "SELECT org_id FROM memberships WHERE user_id = auth.user_id() IS NOT FALSE" })).toEqual(mixed);
    expect(docs("org_id IN (SELECT org_id FROM mine)", { mine: "SELECT org_id FROM memberships WHERE user_id IN (auth.user_id(), 'x')" })).toEqual(mixed);
  });

  it("keeps the narrowest plain tie beside one that is not", () => {
    expect(docs("owner_id = auth.user_id() AND editor_id IN (auth.user_id(), 'x')")).toEqual(owner("owner_id"));
    expect(docs("owner_id = auth.user_id() OR owner_id IN (auth.user_id(), 'system')")).toEqual(mixed);
    expect(docs("auth.user_id() IN (owner_id, editor_id)")).toEqual(group("(owner_id, editor_id)"));
    expect(docs("owner_id IN (auth.user_id(), auth.parameter('acting_for'))")).toEqual(group("claim acting_for"));
  });

  it("ties no group through a table joined by anything but equalities", () => {
    for (const sql of [
      "SELECT todos.* FROM todos JOIN lists ON true WHERE lists.owner_id = auth.user_id()",
      // A todo with no list joins every list, so every list's owner gets it.
      "SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id OR todos.list_id IS NULL WHERE lists.owner_id = auth.user_id()",
      "SELECT * FROM todos WHERE list_id IN (SELECT l.id FROM lists l CROSS JOIN members m WHERE m.user_id = auth.user_id())",
      "SELECT * FROM todos WHERE list_id IN (SELECT l.id FROM lists l, members m WHERE m.user_id = auth.user_id())",
      "SELECT * FROM todos WHERE list_id IN (SELECT l.id FROM lists l JOIN members m ON true WHERE m.user_id = auth.user_id())",
    ]) {
      expect(stream(sql), sql).toEqual(mixed);
    }
    expect(stream("SELECT * FROM todos WHERE list_id IN (SELECT l.id FROM lists l JOIN members m ON m.list_id = l.id WHERE m.user_id = auth.user_id())")).toEqual(
      group("a subquery on lists"),
    );
  });

  it("does the same through sync rules parameter and data queries", () => {
    const docsBy = (parameters: string, data = "SELECT * FROM docs WHERE org_id = bucket.org_id") => bucket([parameters], [data])["data[0]"];
    expect(bucket(["SELECT token_parameters.user_id AS uid"], ["SELECT * FROM docs WHERE owner_id IN (bucket.uid, 'system')"])).toEqual({ "data[0]": [mixed] });
    expect(bucket(["SELECT id AS ws FROM workspaces WHERE owner_id IN (token_parameters.user_id, 'system')"], ["SELECT * FROM docs WHERE ws_id = bucket.ws"])).toEqual({
      "data[0]": [mixed],
    });
    const members = "SELECT org_id FROM members WHERE user_id = token_parameters.user_id";
    expect(docsBy(members)).toEqual([group("parameters[0]")]);
    // The parameter on either side, and either cast.
    expect(docsBy(members, "SELECT * FROM docs WHERE bucket.org_id = org_id")).toEqual([group("parameters[0]")]);
    expect(docsBy(members, "SELECT * FROM docs WHERE org_id = bucket.org_id::text")).toEqual([group("parameters[0]")]);
    expect(docsBy("SELECT org_id::text AS org_id FROM members WHERE user_id = token_parameters.user_id")).toEqual([group("parameters[0]")]);
    for (const [parameters, data] of [
      ["SELECT CASE WHEN token_parameters.is_admin THEN 'all' ELSE token_parameters.org_id END AS org_id", undefined],
      ["SELECT coalesce(token_parameters.org_id, 'public') AS org_id", undefined],
      ["SELECT lower(org_id) AS org_id FROM members WHERE user_id = token_parameters.user_id", undefined],
      [members, "SELECT * FROM docs WHERE bucket.org_id = org_id IS NULL"],
      ["SELECT m.org_id FROM members m, orgs o WHERE o.owner_id = token_parameters.user_id", undefined],
    ] as [string, string | undefined][]) {
      expect(docsBy(parameters, data), parameters).toEqual([mixed]);
    }
  });
});

describe("stream queries sent to a group", () => {
  it("are tied to the user by anything but their own id against the row", () => {
    expect(docs("org_id IN (SELECT org_id FROM memberships WHERE user_id = auth.user_id())")).toEqual(group("a subquery on memberships"));
    expect(docs("org_id IN (SELECT org_id FROM public.memberships WHERE user_id = auth.user_id())")).toEqual(group("a subquery on memberships"));
    expect(docs("org_id IN my_orgs", { my_orgs: "SELECT org_id FROM memberships WHERE user_id = auth.user_id()" })).toEqual(group("with.my_orgs"));
    expect(docs("org_id IN (SELECT org_id FROM mine)", { Mine: "SELECT org_id FROM memberships WHERE user_id = auth.user_id()" })).toEqual(group("with.Mine"));
    expect(docs("org_id = auth.parameter('org_id')")).toEqual(group("claim org_id"));
    expect(docs("org_id IN auth.parameter('org_ids')")).toEqual(group("claim org_ids"));
    expect(docs("team_id = auth.parameter('user_metadata') ->> 'team_id'")).toEqual(group("claim user_metadata.team_id"));
    // A claim named user_id is whatever a hook puts there, not the verified user id.
    expect(docs("owner_id = auth.parameter('user_id')")).toEqual(group("claim user_id"));
  });

  it("take the user id mixed with anything, or against anything but a plain column, for a group", () => {
    expect(docs("lower(owner_id) = auth.user_id()")).toEqual(group("lower(owner_id)"));
    expect(docs("owner_id::text = auth.user_id()")).toEqual(group("owner_id::text"));
    // lower() gives users "A" and "a" the same rows.
    expect(docs("owner_id = lower(auth.user_id())")).toEqual(group("owner_id"));
    expect(docs("owner_id = auth.user_id() || ''")).toEqual(group("owner_id"));
    expect(docs("owner_id = coalesce(auth.user_id(), 'nobody')")).toEqual(group("owner_id"));
    expect(docs("owner_id = coalesce(auth.parameter('acting_for'), auth.user_id())")).toEqual(group("claim acting_for"));
  });

  it("join what each OR branch ties, and keep the narrowest AND term", () => {
    expect(docs("a_id = auth.user_id() OR b_id = auth.user_id()")).toEqual(group("a_id or b_id"));
    expect(docs("owner_id = auth.user_id() OR org_id IN mine", { mine: "SELECT org_id FROM memberships WHERE user_id = auth.user_id()" })).toEqual(
      group("owner_id or with.mine"),
    );
    expect(docs("org_id = auth.parameter('org_id') AND team_id = auth.parameter('team_id')")).toEqual(group("claim org_id"));
    expect(docs("(org_id = auth.parameter('org_id') OR owner_id = auth.user_id()) AND owner_id = auth.user_id()")).toEqual(owner("owner_id"));
  });

  it("take no parent that may be several rows, an outer join, or a set that is no table's keys", () => {
    const cases: [string, string][] = [
      ["SELECT todos.* FROM todos LEFT JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()", "lists.owner_id"],
      ["SELECT todos.* FROM todos RIGHT JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()", "lists.owner_id"],
      // The join reaches the lists that share a column with the row, not one by its key.
      ["SELECT lists.* FROM lists JOIN todos ON todos.list_id = lists.id WHERE todos.owner_id = auth.user_id()", "todos.owner_id"],
      ["SELECT todos.* FROM todos JOIN lists ON todos.list_id::uuid = lists.id WHERE lists.owner_id = auth.user_id()", "lists.owner_id"],
      // In a join, a bare column could be either table's.
      ["SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id WHERE owner_id = auth.user_id()", "owner_id"],
      ["SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id JOIN folders ON lists.folder_id = folders.id WHERE folders.owner_id = auth.user_id()", "folders.owner_id"],
    ];
    for (const [sql, via] of cases) expect(stream(sql), sql).toEqual(group(via));
    // A key of several columns, or none, names no one row.
    for (const key of [["id", "version"], []]) {
      expect(stream("SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id WHERE lists.owner_id = auth.user_id()", {}, () => key)).toEqual(group("lists.owner_id"));
    }
    for (const set of [
      "(SELECT org_id FROM lists WHERE owner_id = auth.user_id())",
      "(SELECT id FROM lists WHERE owner_id = auth.user_id() OR editor_id = auth.user_id())",
      "(SELECT id FROM lists WHERE owner_id = auth.user_id() OR org_id IN (SELECT org_id FROM memberships WHERE user_id = auth.user_id()))",
      "(SELECT id, owner_id FROM lists WHERE owner_id = auth.user_id())",
    ]) {
      expect(stream(`SELECT * FROM todos WHERE list_id IN ${set}`), set).toEqual(group("a subquery on lists"));
    }
    expect(stream("SELECT * FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id())", {}, () => ["uuid"])).toEqual(group("a subquery on lists"));
    // A CTE's rows are whatever it selects, with no key, and a set read from one too.
    const mine = { mine: "SELECT id FROM lists WHERE owner_id = auth.user_id()" };
    expect(stream("SELECT * FROM todos WHERE list_id IN (SELECT id FROM mine WHERE id = id)", mine)).toEqual(group("with.mine"));
    expect(stream("SELECT todos.* FROM todos JOIN mine ON todos.list_id = mine.id WHERE mine.owner_id = auth.user_id()", mine)).toEqual(group("mine.owner_id"));
    expect(stream("SELECT * FROM todos WHERE list_id IN lists", { lists: "SELECT id FROM lists WHERE owner_id = auth.user_id()" })).toEqual(group("with.lists"));
    // A set a UNION widens holds anyone's keys, even beside a term that does tie the rows.
    const orgs = { orgs: "SELECT org_id FROM memberships WHERE user_id = auth.user_id()" };
    expect(stream("SELECT * FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id() UNION SELECT id FROM lists) AND org_id IN orgs", orgs)).toEqual(
      group("with.orgs"),
    );
    expect(stream("SELECT * FROM todos WHERE list_id IN mine AND org_id IN orgs", { ...orgs, mine: "SELECT id FROM lists WHERE owner_id = auth.user_id() UNION SELECT id FROM lists" })).toEqual(
      group("with.orgs"),
    );
    // A CTE that reads another: one parent deep only.
    expect(
      stream("SELECT * FROM todos WHERE list_id IN mine", { me: "SELECT id FROM users WHERE id = auth.user_id()", mine: "SELECT id FROM lists WHERE owner_id IN me" }),
    ).toEqual(group("with.mine"));
  });
});

describe("stream queries the token does not tie to the row", () => {
  it("go to whoever passes a role or claim check", () => {
    for (const where of [
      "auth.parameter('app_metadata') ->> 'role' = 'admin'",
      "auth.user_id() IN (SELECT user_id FROM admins)",
      "'admin' IN (SELECT role FROM user_roles WHERE user_id = auth.user_id())",
      "auth.user_id() = '1b6c'::uuid",
      // Their own rows, or all of them for an admin: the admins get everything.
      "owner_id = auth.user_id() OR auth.parameter('app_metadata') ->> 'role' = 'admin'",
      "status = 'public' AND auth.user_id() IN (SELECT user_id FROM admins)",
    ]) {
      expect(docs(where), where).toEqual(role);
    }
  });

  it("go to every user, for the rows a fixed filter picks", () => {
    for (const where of ["status = 'public'", "is_public", "docs.is_public AND kind IN ('a', 'b')", "owner_id = auth.user_id() OR status = 'public'", "auth.user_id() IN (SELECT user_id FROM admins) OR status = 'public'"]) {
      expect(docs(where), where).toEqual(fixed);
    }
  });

  it("go to whichever client asks", () => {
    for (const where of [
      "id = subscription.parameter('id')",
      "id = connection.parameter('id')",
      "id = request.parameters() ->> 'id'",
      "owner_id = coalesce(subscription.parameter('uid'), auth.user_id())",
      "owner_id = auth.user_id() OR id = subscription.parameter('id')",
      "id = subscription.parameter('id') AND auth.parameter('app_metadata') ->> 'role' = 'admin'",
    ]) {
      expect(docs(where), where).toEqual(client);
    }
  });

  it("go to every user when nothing limits them", () => {
    expect(stream("SELECT * FROM docs")).toEqual(everyone);
    for (const where of [
      "owner_id = auth.user_id() OR true",
      "auth.parameter('role') = 'authenticated'",
      "owner_id IS NOT NULL",
      "auth.user_id() IS NOT NULL",
      "NOT owner_id = auth.user_id()",
      "owner_id = (SELECT auth.user_id())",
      "list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id() UNION SELECT id FROM lists)",
      "auth.user_id() = auth.user_id()",
    ]) {
      expect(docs(where), where).toEqual(everyone);
    }
  });

  it("cannot be read when the query, or a CTE it reads, cannot be, or it is compound", () => {
    expect(docs("x = E'y'")).toBeNull();
    // The access analysis would take both SELECTs' conditions for one query's.
    expect(stream("SELECT * FROM lists WHERE owner_id = auth.user_id() UNION SELECT * FROM lists")).toBeNull();
    expect(stream("(SELECT * FROM lists WHERE owner_id = auth.user_id()) EXCEPT (SELECT * FROM lists WHERE id = 'x')")).toBeNull();
    expect(docs("org_id IN bad", { bad: "SELECT org_id FROM m WHERE x = E'y'" })).toBeNull();
    // One it does not read is no matter.
    expect(stream("SELECT * FROM lists WHERE owner_id = auth.user_id()", { bad: "SELECT x FROM m WHERE x = E'y'" })).toEqual(owner("owner_id"));
  });
});

describe("sync rules data queries", () => {
  it("go to the owner through the user id, or through the key of the user's own rows", () => {
    // The to-do list demo's sync rules.
    expect(bucket(["SELECT id AS list_id FROM lists WHERE owner_id = request.user_id()"], ["SELECT * FROM lists WHERE id = bucket.list_id", "SELECT * FROM todos WHERE list_id = bucket.list_id"])).toEqual({
      "data[0]": [owner("owner_id")],
      "data[1]": [owner("list_id", { table: "lists", column: "owner_id" })],
    });
    for (const parameters of [
      "SELECT request.user_id() AS user_id",
      "SELECT token_parameters.user_id AS user_id",
      "SELECT request.jwt() ->> 'sub' AS user_id",
      "SELECT (request.user_id())::text AS user_id",
      "SELECT (SELECT request.user_id()) AS user_id",
    ]) {
      expect(bucket([parameters], ["SELECT * FROM lists WHERE owner_id = bucket.user_id", "SELECT * FROM users WHERE bucket.user_id = users.id"]), parameters).toEqual({
        "data[0]": [owner("owner_id")],
        "data[1]": [owner("id")],
      });
    }
    // The user's own row by its key: the user id itself.
    expect(bucket(["SELECT id AS uid FROM users WHERE id = request.user_id()"], ["SELECT * FROM notes WHERE author = bucket.uid"])).toEqual({ "data[0]": [owner("author")] });
    expect(bucket(["SELECT l.id FROM lists l WHERE l.owner_id = token_parameters.user_id"], ["SELECT * FROM lists WHERE parent_id = bucket.id"])).toEqual({
      "data[0]": [owner("parent_id", { table: "lists", column: "owner_id" })],
    });
    expect(bucket([`SELECT "Id" AS list_id FROM "Lists" WHERE "Lists"."ownerId" = request.user_id()`], [`SELECT * FROM "Todos" WHERE "listId" = bucket.list_id`], () => ["Id"])).toEqual({
      "data[0]": [owner("listId", { table: "Lists", column: "ownerId" })],
    });
  });

  it("go to a group through any other parameter the token gives", () => {
    const data = ["SELECT * FROM lists WHERE id = bucket.list_id", "SELECT * FROM todos WHERE list_id = bucket.list_id"];
    for (const parameters of [
      "SELECT list_id FROM list_members WHERE user_id = request.user_id()",
      // Not the key, or not one owner column, or another table's.
      "SELECT owner_id AS list_id FROM lists WHERE owner_id = request.user_id()",
      "SELECT id AS list_id FROM lists WHERE owner_id = request.user_id() OR editor_id = request.user_id()",
      "SELECT lists.id AS list_id FROM lists JOIN users ON users.id = lists.owner_id WHERE users.id = request.user_id()",
      "SELECT request.jwt() ->> 'list' AS list_id",
      // A name given twice.
      "SELECT id AS list_id, org_id AS list_id FROM lists WHERE owner_id = request.user_id()",
    ]) {
      expect(bucket([parameters], data), parameters).toEqual({ "data[0]": [group("parameters[0]")], "data[1]": [group("parameters[0]")] });
    }
    expect(bucket(["SELECT id AS list_id FROM lists WHERE owner_id = request.user_id()"], data, () => ["uuid"])).toEqual({ "data[0]": [group("parameters[0]")], "data[1]": [group("parameters[0]")] });
    // A column of no table the query reads by that name.
    expect(bucket(["SELECT request.user_id() AS user_id, org_id FROM members WHERE user_id = request.user_id()"], ["SELECT * FROM todos t WHERE t.org = bucket.org_id AND todos.owner_id = bucket.user_id"])).toEqual({
      "data[0]": [group("parameters[0]")],
    });
    // Two owners in OR.
    expect(bucket(["SELECT request.user_id() AS uid"], ["SELECT * FROM chats WHERE a_id = bucket.uid OR b_id = bucket.uid"])).toEqual({ "data[0]": [group("parameters[0]")] });
  });

  it("say what each parameter query gives, as the rules do", () => {
    expect(bucket(["SELECT id AS org_id FROM orgs WHERE request.jwt() ->> 'role' = 'admin'"], ["SELECT * FROM projects WHERE org_id = bucket.org_id"])).toEqual({ "data[0]": [role] });
    expect(bucket(["SELECT id AS list_id FROM lists WHERE status = 'shared'"], ["SELECT * FROM todos WHERE list_id = bucket.list_id"])).toEqual({ "data[0]": [fixed] });
    // A claim every user shares hands every user the same bucket.
    expect(bucket(["SELECT request.jwt() ->> 'role' AS r FROM users WHERE id = request.user_id() AND deleted = false"], ["SELECT * FROM t WHERE audience = bucket.r"])).toEqual({
      "data[0]": [everyone],
    });
    expect(bucket(["SELECT request.parameters() ->> 'id' AS id"], ["SELECT * FROM lists WHERE id = bucket.id"])).toEqual({ "data[0]": [client] });
    expect(bucket(["SELECT request.parameters() ->> 'org' AS org_id FROM members WHERE user_id = request.user_id()"], ["SELECT * FROM t WHERE org_id = bucket.org_id"])).toEqual({
      "data[0]": [client],
    });
    expect(bucket(["SELECT id AS list_id FROM lists"], ["SELECT * FROM todos WHERE list_id = bucket.list_id"])).toEqual({ "data[0]": [everyone] });
    // One entry per parameter query, each its own.
    expect(
      bucket(["SELECT request.user_id() AS uid, request.parameters() ->> 'x' AS x", "SELECT id AS uid, id AS x FROM users"], ["SELECT * FROM a WHERE owner = bucket.uid", "SELECT * FROM b WHERE x = bucket.x"]),
    ).toEqual({ "data[0]": [owner("owner"), everyone], "data[1]": [client, everyone] });
  });

  it("send rows no parameter limits to every user the bucket reaches", () => {
    expect(bucket([], ["SELECT * FROM announcements", "SELECT * FROM posts WHERE status = 'public'", "SELECT * FROM lists WHERE owner_id = bucket.user_id"])).toEqual({
      "data[0]": [everyone],
      "data[1]": [fixed],
      "data[2]": [everyone],
    });
    expect(bucketAudiences(new Map(), [{ label: "data[0]", sql: "SELECT * FROM announcements" }]).get("data[0]")).toEqual([{ via: "no parameter query", audience: everyone }]);
    expect(bucket(["SELECT request.user_id() AS user_id"], ["SELECT * FROM lists WHERE owner_id = bucket.user_id OR true", "SELECT * FROM tags"])).toEqual({
      "data[0]": [everyone],
      "data[1]": [everyone],
    });
    // A bucket only users passing a check reach; a gate beside a parameter query that is none.
    expect(bucket(["SELECT FROM users WHERE id = request.user_id() AND is_admin"], ["SELECT * FROM customers"])).toEqual({ "data[0]": [role] });
    expect(bucket(["SELECT WHERE request.jwt() ->> 'role' = 'admin'", "SELECT request.user_id() AS uid"], ["SELECT * FROM customers WHERE region = 'eu'"])).toEqual({
      "data[0]": [role, fixed],
    });
    expect(bucket(["SELECT FROM users WHERE id = request.user_id() AND request.jwt() ->> 'role' = 'authenticated'"], ["SELECT * FROM payroll"])).toEqual({ "data[0]": [everyone] });
  });

  it("leave out data queries that cannot be read or are compound, and give every user through such a parameter query", () => {
    expect(bucket(["SELECT request.user_id() AS user_id"], ["SELECT * FROM lists WHERE owner_id = bucket.user_id", "SELECT * FROM notes WHERE x = E'y'"])).toEqual({
      "data[0]": [owner("owner_id")],
    });
    expect(bucket(["SELECT request.user_id() AS user_id", "SELECT user_id FROM m WHERE x = E'y'", "SELECT * FROM members"], ["SELECT * FROM lists WHERE owner_id = bucket.user_id"])).toEqual({
      "data[0]": [owner("owner_id"), everyone, everyone],
    });
    // Nor compound ones, whose conditions the access analysis would read as one query's.
    expect(
      bucket(["SELECT id AS list_id FROM lists WHERE owner_id = request.user_id() UNION SELECT id FROM lists"], ["SELECT * FROM todos WHERE list_id = bucket.list_id", "SELECT * FROM t WHERE x = bucket.list_id UNION ALL SELECT * FROM t"]),
    ).toEqual({ "data[0]": [everyone] });
  });

  it("read the trello demo's buckets, one parameter query at a time", () => {
    const text = corpusFiles("real").find((c) => c.file === "powersync-dart-trello-legacy.yaml")?.text ?? "";
    const s = parseSyncConfig(text).streams.find((x) => x.name === "by_workspace");
    const by = s ? bucketAudiences(s.ctes, s.queries) : new Map();
    expect(by.get("data[0]")).toEqual([
      { via: "parameters[0]", audience: owner("userId") },
      { via: "parameters[1]", audience: group("parameters[1]") },
      // visibility = "Public" compares two columns: it picks no fixed rows.
      { via: "parameters[2]", audience: everyone },
    ]);
    expect(by.get("data[1]")?.[0]).toEqual({ via: "parameters[0]", audience: owner("workspaceId", { table: "workspace", column: "userId" }) });
  });
});

describe("widest", () => {
  it("is the widest kind, AUDIENCE_ORDER running from narrowest to widest", () => {
    expect(AUDIENCE_ORDER).toEqual(["owner", "group", "role", "fixed", "client", "everyone"]);
    expect(widest([owner("owner_id")])).toEqual(owner("owner_id"));
    expect(widest([owner("owner_id"), fixed, role])).toEqual(fixed);
    expect(widest([client, everyone, group("x")])).toEqual(everyone);
    expect(widest([owner("owner_id"), owner("owner_id")])).toEqual(owner("owner_id"));
    expect(() => widest([])).toThrow();
  });

  it("makes a group of owners named by different columns, or of an owner and a group", () => {
    expect(widest([owner("a_id"), owner("b_id")])).toEqual(group("a_id or b_id"));
    expect(widest([owner("list_id", { table: "lists", column: "owner_id" }), owner("list_id", { table: "lists", column: "editor_id" })])).toEqual(group("lists.owner_id or lists.editor_id"));
    expect(widest([owner("owner_id"), group("with.mine"), group("with.mine")])).toEqual(group("owner_id or with.mine"));
    expect(widest([group("parameters[0]"), group("parameters[0]")])).toEqual(group("parameters[0]"));
  });
});

describe("audienceText", () => {
  it("says each in plain words", () => {
    expect([owner("owner_id"), owner("list_id", { table: "lists", column: "owner_id" }), group("with.my_orgs"), role, fixed, client, everyone].map(audienceText)).toEqual([
      "only the row's owner (owner_id)",
      "only the owner of its lists row (lists.owner_id)",
      "members of the row's group, through with.my_orgs",
      "whoever passes a role or claim check",
      "every user, for rows a fixed filter picks",
      "whichever rows a client asks for",
      "every user",
    ]);
  });
});

describe("audiences on the corpus", () => {
  const corpus = (["real", "planted"] as const).flatMap((dir) => corpusFiles(dir).map((c) => ({ ...c, file: `${dir}/${c.file}` })));

  /** Each query of a config with who receives its rows: a bucket's through each parameter query. */
  function audiences(text: string): string[] {
    const config = parseSyncConfig(text);
    return config.streams.flatMap((s) => {
      if (config.kind === "streams") {
        return s.queries.map((q) => {
          const a = streamAudience(q.sql, s.ctes);
          return `${s.name} ${q.label}: ${a ? audienceText(a) : "cannot be read"}`;
        });
      }
      const by = bucketAudiences(s.ctes, s.queries);
      return s.queries.map((q) => `${s.name} ${q.label}: ${(by.get(q.label) ?? []).map((e) => `${e.via}: ${audienceText(e.audience)}`).join("; ") || "cannot be read"}`);
    });
  }

  it("gives the to-do list demo's lists to their owner, and its todos to the owner of their list", () => {
    const text = corpus.find((c) => c.file === "real/powersync-js-todolist.yaml")?.text ?? "";
    const [s] = parseSyncConfig(text).streams;
    expect(s?.queries.map((q) => streamAudience(q.sql, s.ctes))).toEqual([owner("owner_id"), owner("list_id", { table: "lists", column: "owner_id" })]);
  });

  it("gives every user wherever unscoped-query fails a query, and a client's pick wherever client-scoped does", () => {
    const rules: [LintRule, Audience["kind"]][] = [
      [unscopedQuery, "everyone"],
      [clientScoped, "client"],
    ];
    const found: string[] = [];
    let errors = 0;
    for (const { file, text } of corpus) {
      const config = parseSyncConfig(text);
      const at = lineFinder(text);
      const on = (sql: string, line: number | undefined) => line !== undefined && at(sql)?.line === line;
      for (const [rule, kind] of rules) {
        for (const f of lintSyncConfig(text, file, [rule]).filter((x) => x.level === "error")) {
          errors++;
          for (const s of config.streams) {
            if (config.kind === "streams") {
              for (const q of s.queries.filter((x) => on(x.sql, f.line))) found.push(`${file} ${s.name} ${q.label}: ${streamAudience(q.sql, s.ctes)?.kind} for ${kind}`);
              continue;
            }
            const by = bucketAudiences(s.ctes, s.queries);
            for (const q of s.queries.filter((x) => on(x.sql, f.line))) found.push(`${file} ${s.name} ${q.label}: ${widest((by.get(q.label) ?? []).map((e) => e.audience)).kind} for ${kind}`);
            // A failed parameter query: what each data query gets through it.
            for (const [label] of [...s.ctes].filter(([, sql]) => on(sql, f.line))) {
              const through = [...by.values()].map((entries) => entries.find((e) => e.via === label)?.audience.kind);
              found.push(`${file} ${s.name} ${label}: ${[...new Set(through)].join(", ")} for ${kind}`);
            }
          }
        }
      }
    }
    expect(found.length).toBe(errors);
    expect(found).toEqual([
      "real/powersync-dart-trello-global-legacy.yaml global data[0]: everyone for everyone",
      "real/powersync-dart-trello-legacy.yaml user_info data[0]: everyone for everyone",
      "real/powersync-dart-trello-legacy.yaml by_workspace parameters[2]: everyone for everyone",
      "real/powersync-js-nextjs.yaml global queries[0]: everyone for everyone",
      "real/powersync-js-text-collab-legacy.yaml documents parameters[0]: client for client",
      "real/powersync-js-text-collab.yaml documents queries[0]: client for client",
      "real/powersync-js-text-collab.yaml documents queries[1]: client for client",
      "real/powersync-js-time-based.yaml issues_by_date query: client for client",
      "planted/client-parameter-scope.yaml tasks parameters[0]: client for client",
      "planted/missing-owner-filter.yaml user_data queries[1]: everyone for everyone",
      "planted/unbound-parameter-query.yaml user_lists parameters[0]: everyone for everyone",
    ]);
  });

  it("gives every query in it the same audience as last time", () => {
    expect(Object.fromEntries(corpus.map((c) => [c.file, audiences(c.text)]))).toMatchInlineSnapshot(`
      {
        "planted/client-parameter-scope.yaml": [
          "tasks data[0]: parameters[0]: whichever rows a client asks for",
        ],
        "planted/missing-owner-filter.yaml": [
          "user_data queries[0]: only the row's owner (owner_id)",
          "user_data queries[1]: every user",
        ],
        "planted/unbound-parameter-query.yaml": [
          "user_lists data[0]: parameters[0]: every user",
        ],
        "planted/user-metadata-scope.yaml": [
          "user_tasks queries[0]: members of the row's group, through claim user_metadata.team_id",
        ],
        "real/powersync-dart-trello-global-legacy.yaml": [
          "global data[0]: parameters[0]: every user",
          "global data[1]: parameters[0]: every user",
          "global data[2]: parameters[0]: every user",
          "global data[3]: parameters[0]: every user",
          "global data[4]: parameters[0]: every user",
          "global data[5]: parameters[0]: every user",
          "global data[6]: parameters[0]: every user",
          "global data[7]: parameters[0]: every user",
          "global data[8]: parameters[0]: every user",
          "global data[9]: parameters[0]: every user",
          "global data[10]: parameters[0]: every user",
          "global data[11]: parameters[0]: every user",
        ],
        "real/powersync-dart-trello-legacy.yaml": [
          "user_info data[0]: no parameter query: every user",
          "by_workspace data[0]: parameters[0]: only the row's owner (userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[1]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[2]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[3]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[4]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[5]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[6]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[7]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[8]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[9]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
          "by_workspace data[10]: parameters[0]: only the owner of its workspace row (workspace.userId); parameters[1]: members of the row's group, through parameters[1]; parameters[2]: every user",
        ],
        "real/powersync-js-multi-client-legacy.yaml": [
          "user_lists data[0]: parameters[0]: only the row's owner (user_id)",
        ],
        "real/powersync-js-multi-client.yaml": [
          "user_lists queries[0]: only the row's owner (user_id)",
        ],
        "real/powersync-js-nextjs.yaml": [
          "global queries[0]: every user",
        ],
        "real/powersync-js-nuxt-legacy.yaml": [
          "tasks data[0]: parameters[0]: only the row's owner (user_id)",
        ],
        "real/powersync-js-nuxt.yaml": [
          "user_tasks queries[0]: only the row's owner (user_id)",
        ],
        "real/powersync-js-text-collab-legacy.yaml": [
          "documents data[0]: parameters[0]: whichever rows a client asks for",
          "documents data[1]: parameters[0]: whichever rows a client asks for",
        ],
        "real/powersync-js-text-collab.yaml": [
          "documents queries[0]: whichever rows a client asks for",
          "documents queries[1]: whichever rows a client asks for",
        ],
        "real/powersync-js-time-based.yaml": [
          "issues_by_date query: whichever rows a client asks for",
        ],
        "real/powersync-js-todolist.yaml": [
          "user_data queries[0]: only the row's owner (owner_id)",
          "user_data queries[1]: only the owner of its lists row (lists.owner_id)",
        ],
      }
    `);
  });
});
