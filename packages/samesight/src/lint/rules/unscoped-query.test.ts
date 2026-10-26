import { describe, expect, it } from "vitest";
import { corpusFindings, plantedExpecting } from "../../fixtures/corpus.ts";
import { lintSyncConfig } from "../lint.ts";
import { unscopedQuery } from "./unscoped-query.ts";

const lint = (yaml: string) => lintSyncConfig(yaml, "s.yaml", [unscopedQuery]).map((f) => [f.level, f.line, f.message]);
const stream = (body: string) => `config:\n  edition: 3\nstreams:\n${body}`;

describe("unscoped-query on sync streams", () => {
  it("fails a query that reads no token value, and warns when only fixed values filter it", () => {
    expect(lint(stream("  all:\n    auto_subscribe: true\n    query: SELECT * FROM customers\n"))).toEqual([
      ["error", 6, "stream all, query sends every row of customers to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim"],
    ]);
    expect(lint(stream("  pub:\n    query: SELECT * FROM posts WHERE status = 'published'\n"))).toEqual([
      ["warning", 5, "stream pub, query sends every user the rows of posts its fixed filters allow, whatever their token says; fine if those are public by design"],
    ]);
  });

  it("does not take a comparison of two columns, or of two literals, for a filter", () => {
    for (const where of ["1 = 1", "id = id", "created_by = updated_by"]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM docs WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["error"]);
    }
  });

  it("accepts a query tied to the token, directly, through a join or through a CTE", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id()\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM projects WHERE org_id = auth.parameter('org_id')\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT todos.* FROM todos JOIN lists ON todos.list_id = lists.id AND lists.owner_id = auth.user_id()\n"))).toEqual([]);
    expect(lint(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id()\n    query: SELECT * FROM todos WHERE list_id IN mine\n"))).toEqual([]);
    expect(
      lint(stream("  s:\n    with:\n      mine: SELECT org_id FROM members WHERE user_id = auth.user_id()\n    query: SELECT * FROM projects WHERE org_id IN (SELECT org_id FROM mine)\n")),
    ).toEqual([]);
  });

  it("counts a token value only where a row is compared with it", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id() OR true\n"))).toEqual([
      ["error", 5, "stream s, query reads the requesting user's token, but not in a way that limits which rows of lists it sends, so every user gets every row"],
    ]);
    for (const where of [
      "auth.user_id() IS NOT NULL",
      "NOT owner_id = auth.user_id()",
      "auth.user_id() = auth.user_id()",
      "owner_id = auth.user_id() OR owner_id = owner_id",
      "author_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = auth.user_id())",
    ]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM lists WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["error"]);
    }
    // left() is a function, not a join that ends the WHERE.
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE left(name, 1) = 'a' AND owner_id = auth.user_id()\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE owner_id = auth.user_id() OR left(name, 1) = 'a'\n")).map((f) => f[0])).toEqual(["warning"]);
    expect(lint(stream("  s:\n    query: SELECT * FROM lists WHERE auth.user_id() IS NOT NULL AND status = 'open'\n"))).toEqual([
      ["warning", 5, "stream s, query sends every user the rows of lists its fixed filters allow, whatever their token says; fine if those are public by design"],
    ]);
    // Their own rows and every public one: the public ones reach everyone.
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE owner_id = auth.user_id() OR status = 'public'\n")).map((f) => f[0])).toEqual(["warning"]);
    // An outer join keeps every todo, whatever its ON says.
    expect(
      lint(stream("  s:\n    query: SELECT todos.* FROM todos LEFT JOIN lists ON todos.list_id = lists.id AND lists.owner_id = auth.user_id()\n")).map((f) => f[0]),
    ).toEqual(["error"]);
    expect(lint(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id() OR true\n    query: SELECT * FROM todos WHERE list_id IN mine\n")).map((f) => f[0])).toEqual([
      "error",
    ]);
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id() OR true)\n")).map((f) => f[0])).toEqual([
      "error",
    ]);
  });

  it("fails a claim every signed-in or non-anonymous Supabase user passes, however the value is written", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE auth.parameter('role') = 'authenticated'\n"))).toEqual([
      [
        "error",
        5,
        "stream s, query checks a claim every signed-in Supabase user passes (role or aud = 'authenticated') or every non-anonymous one (is_anonymous = false), so every user gets every row of docs",
      ],
    ]);
    for (const where of [
      "owner_id = auth.user_id() OR auth.parameters() ->> 'aud' = 'authenticated'",
      "auth.parameter('role') = 'authenticated'::text",
      "auth.parameter('role') = CAST('authenticated' AS text)",
      "auth.parameter('is_anonymous') = false",
      "auth.parameter('is_anonymous') = 0",
      "(auth.parameters() -> 'is_anonymous') = 'false'",
      "auth.parameter('is_anonymous')::text = '0'",
      // Every user's role is in the set if 'authenticated' is.
      "auth.parameter('role') IN (SELECT role FROM doc_roles)",
      "(auth.parameters()) ->> 'role' = 'authenticated'",
      "auth.parameters()::json ->> 'role' = 'authenticated'",
      "auth.parameter('role') = 'authenticated'::\"text\"",
      // A client-picked value in one branch is no filter beside an admin check or public rows.
      "org_id = subscription.parameter('org') OR auth.user_id() IN (SELECT user_id FROM admins)",
      "org_id = subscription.parameter('org') OR status = 'public'",
      // A client can name an admin, or pick its own rows beside an admin check.
      "coalesce(subscription.parameter('u'), auth.user_id()) IN (SELECT user_id FROM admins)",
      "owner = coalesce(subscription.parameter('u'), auth.user_id()) OR auth.user_id() IN (SELECT user_id FROM admins)",
      // Every user's role is the same: a column compared with it tells no user apart.
      "public_to = auth.parameter('role')",
      "tenant = auth.parameter('iss')",
      "public_to = auth.parameter('aud')",
      "public_to = auth.parameter('is_anonymous')",
      "tier = auth.parameter('aal')",
      "method = auth.parameter('amr')",
      "auth.parameter('role') = lower('AUTHENTICATED')",
      // A client value IN the user's own set only proves the set is not empty.
      "subscription.parameter('org') IN (SELECT org_id FROM members WHERE user_id = auth.user_id())",
      // A set that holds anything: a literal, the client's value, a UNION.
      "'admin' IN (SELECT 'admin' FROM users WHERE id = auth.user_id())",
      "auth.user_id() IN (SELECT subscription.parameter('u'))",
      "org_id IN (SELECT org_id FROM members WHERE user_id = auth.user_id() UNION SELECT id FROM orgs)",
      "org_id IN ((SELECT org_id FROM members WHERE user_id = auth.user_id()) UNION (SELECT id FROM orgs))",
      // A set that selects the client's value holds whatever the client sends.
      "org_id IN (SELECT subscription.parameter('org') FROM members WHERE user_id = auth.user_id())",
      "upper(auth.parameter('role')) = 'AUTHENTICATED'",
      "(auth.parameters() -> 'role') = '\"authenticated\"'",
      // Any client passes by sending its own id.
      "auth.user_id() = subscription.parameter('uid')",
      // Nothing about who is asking: a literal in a set anyone is in, or a client value.
      "1 IN (SELECT 1)",
      "'x' IN (SELECT name FROM flags)",
      "subscription.parameter('org') IN (SELECT id FROM orgs)",
    ]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM docs WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["error"]);
    }
    // A role kept under another key is the app's, not the one every token carries.
    for (const where of ["auth.parameters() -> 'app_metadata' ->> 'role' = 'authenticated'", "json_extract(auth.parameters(), '$.app_metadata') ->> 'role' = 'authenticated'"]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM docs WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["warning"]);
    }
    // Nobody's role is 'AUTHENTICATED': a check, not every user.
    for (const where of ["auth.parameter('role') = 'AUTHENTICATED'"]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM docs WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["warning"]);
    }
    // app_metadata.role is the app's own, so a check on it is a role, not every token.
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE auth.parameter('app_metadata') ->> 'role' = 'authenticated'\n")).map((f) => f[0])).toEqual(["warning"]);
  });

  it("fails a CTE set that selects a client value or adds rows by UNION", () => {
    for (const cte of [
      "SELECT subscription.parameter('org') AS org_id FROM members WHERE user_id = auth.user_id()",
      "SELECT org_id FROM members WHERE user_id = auth.user_id() UNION SELECT id FROM orgs",
    ]) {
      expect(lint(stream(`  s:\n    with:\n      mine: ${cte}\n    query: SELECT * FROM docs WHERE org_id IN mine\n`)).map((f) => f[0]), cte).not.toEqual([]);
    }
  });

  it("takes SELECT DISTINCT for one column", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE 'admin' IN (SELECT DISTINCT role FROM user_roles WHERE user_id = auth.user_id())\n")).map((f) => f[0])).toEqual(["warning"]);
  });

  it("fails a literal or client value checked in a CTE anyone's rows fill", () => {
    for (const where of ["subscription.parameter('org') IN pub", "'x' IN pub"]) {
      expect(lint(stream(`  s:\n    with:\n      pub: SELECT id FROM orgs WHERE status = 'active'\n    query: SELECT * FROM docs WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["error"]);
    }
    expect(lint(stream("  s:\n    with:\n      mine: SELECT role FROM user_roles WHERE user_id = auth.user_id()\n    query: SELECT * FROM docs WHERE 'admin' IN mine\n")).map((f) => f[0])).toEqual(["warning"]);
    // The user's own set read through a CTE inside a subquery, its conditions or its FROM,
    // or a CTE that reads another.
    expect(
      lint(stream("  s:\n    with:\n      me: SELECT id FROM users WHERE id = auth.user_id()\n    query: SELECT * FROM docs WHERE 'admin' IN (SELECT role FROM user_roles WHERE user_id IN me)\n")).map((f) => f[0]),
    ).toEqual(["warning"]);
    expect(lint(stream("  s:\n    with:\n      mine: SELECT role FROM user_roles WHERE user_id = auth.user_id()\n    query: SELECT * FROM docs WHERE 'admin' IN (SELECT role FROM mine)\n")).map((f) => f[0])).toEqual([
      "warning",
    ]);
    expect(
      lint(stream("  s:\n    with:\n      me: SELECT id FROM users WHERE id = auth.user_id()\n      mine: SELECT role FROM user_roles WHERE user_id IN me\n    query: SELECT * FROM docs WHERE 'admin' IN mine\n")).map((f) => f[0]),
    ).toEqual(["warning"]);
  });

  it("keeps a fixed filter a filter when its value is cast, and takes a flag column for one", () => {
    for (const where of ["status = 'public'::text", "status = 'active'::\"Status\"", "is_public"]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM posts WHERE ${where}\n`)).map((f) => f[0]), where).toEqual(["warning"]);
    }
  });

  it("says only the filtered rows go to whoever passes a role check beside a filter", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE status = 'public' AND auth.parameter('app_metadata') ->> 'role' = 'admin'\n")).map((f) => f[2])).toEqual([
      expect.stringMatching(/^stream s, query sends the rows of docs its fixed filters allow to every user who passes its check on who is asking/),
    ]);
  });

  it("leaves a query reading an unreadable CTE by JOIN or by quoted name to unreadable-query", () => {
    const bad = (name: string) => `    with:\n      ${name}: SELECT org_id FROM m WHERE x = E'y'\n`;
    expect(lint(stream(`  s:\n${bad("mine")}    query: SELECT docs.* FROM docs JOIN mine ON mine.org_id = docs.org_id\n`))).toEqual([]);
    expect(lint(stream(`  s:\n${bad("mine")}    query: SELECT * FROM docs WHERE org_id IN "mine"\n`))).toEqual([]);
    expect(lint(stream(`  s:\n${bad("Mine")}    query: SELECT * FROM docs WHERE org_id IN "Mine"\n`))).toEqual([]);
  });

  it("still reports a query that only mentions an unreadable CTE's name", () => {
    expect(lint(stream("  s:\n    with:\n      owner: SELECT id FROM x WHERE a = E'b'\n    query: SELECT * FROM docs WHERE owner = owner\n")).map((f) => f[0])).toEqual(["error"]);
  });

  it("takes a CTE that reads itself for no limit, and a CTE read twice for the same limit", () => {
    expect(lint(stream("  s:\n    with:\n      a: SELECT id FROM docs WHERE id IN a\n    query: SELECT * FROM docs WHERE id IN a\n")).map((f) => f[0])).toEqual(["error"]);
    expect(lint(stream("  s:\n    with:\n      mine: SELECT id FROM lists WHERE owner_id = auth.user_id()\n    query: SELECT * FROM todos WHERE list_id IN mine OR parent_list_id IN mine\n"))).toEqual([]);
  });

  it("survives a CTE that reads itself", () => {
    expect(lint(stream("  s:\n    with:\n      a: SELECT id FROM docs WHERE id IN a\n    query: SELECT * FROM docs WHERE id IN a AND owner_id = auth.user_id()\n"))).toEqual([]);
  });

  it("warns about rows sent to whoever passes a role claim or an admin list", () => {
    const message = "stream s, query sends every row of customers to every user who passes its check on who is asking (a role claim, or a list such as admins), not each user their own; fine if only users meant to see them all pass it";
    expect(lint(stream("  s:\n    query: SELECT * FROM customers WHERE auth.parameter('app_metadata') ->> 'role' = 'admin'\n"))).toEqual([["warning", 5, message]]);
    expect(lint(stream("  s:\n    query: SELECT * FROM customers WHERE auth.user_id() IN (SELECT user_id FROM admins)\n"))).toEqual([["warning", 5, message]]);
    for (const where of [
      "auth.parameter('app_metadata') ->> 'role' = 'admin'::text",
      "auth.parameter('app_metadata') ->> 'role' = lower('ADMIN')",
      "'admin' IN (SELECT role FROM user_roles WHERE user_id = auth.user_id())",
      // One named user gets every row.
      "auth.user_id() = '1b6c'::uuid",
    ]) {
      expect(lint(stream(`  s:\n    query: SELECT * FROM customers WHERE ${where}\n`)), where).toEqual([["warning", 5, message]]);
    }
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE auth.user_id() IN (SELECT user_id FROM admins) OR status = 'public'\n"))).toEqual([
      [
        "warning",
        5,
        "stream s, query sends every user the rows of docs its fixed filters allow, and every row to users who pass its check on who is asking (a role claim, or a list such as admins); fine if those rows are public and only users meant to see them all pass the check",
      ],
    ]);
    expect(lint(stream("  s:\n    query: SELECT * FROM docs WHERE auth.parameter('app_metadata') ->> 'role' = 'admin' OR status = 'public'\n")).map((f) => f[2])).toEqual([
      expect.stringMatching(/its fixed filters allow, and every row to users who pass/),
    ]);
    // Own rows, or all of them for an admin.
    expect(lint(stream("  s:\n    query: SELECT * FROM customers WHERE owner_id = auth.user_id() OR auth.parameter('app_metadata') ->> 'role' = 'admin'\n")).map((f) => f[0])).toEqual([
      "warning",
    ]);
  });

  it("accepts every OR branch tied to the user, and a subquery that is", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM chats WHERE (a_id = auth.user_id() OR b_id = auth.user_id())\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id IN (SELECT id FROM lists WHERE owner_id = auth.user_id())\n"))).toEqual([]);
  });

  it("leaves queries the client scopes, and words inside strings, to other rules", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM todos WHERE list_id = subscription.parameter('list_id')\n"))).toEqual([]);
    expect(lint(stream("  s:\n    query: SELECT * FROM notes WHERE body = 'auth.user_id()'\n")).map((f) => f[0])).toEqual(["warning"]);
  });

  it("names the table plainly when it cannot tell which", () => {
    expect(lint(stream("  s:\n    query: SELECT * FROM a LEFT JOIN b ON a.id = b.id\n")).map((f) => f[2])).toEqual([
      "stream s, query sends every row of its table to every user: nothing in it reads the requesting user (auth.user_id()) or a token claim",
    ]);
  });
});

describe("unscoped-query on sync rules", () => {
  it("fails a bucket with no parameter query, and a parameter query that reads no token value", () => {
    expect(lint("bucket_definitions:\n  global:\n    data:\n      - SELECT * FROM announcements\n")).toEqual([
      ["error", 4, "bucket global has no parameter query, so every user receives every row of announcements"],
    ]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS list_id FROM lists\n    data:\n      - SELECT * FROM todos WHERE list_id = bucket.list_id\n")).toEqual([
      ["error", 3, "bucket b, parameters[0] reads nothing from the requesting user's token (request.user_id(), token_parameters), so every user gets every bucket it lists"],
    ]);
  });

  it("fails data queries that read no bucket parameter, even under a parameter query tied to the user", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT FROM users WHERE users.id = token_parameters.user_id\n    data:\n      - SELECT * FROM boards\n      - SELECT * FROM cards\n")).toEqual([
      ["error", 5, "bucket b: its data queries are not limited by a bucket parameter, so every user it reaches receives every row of boards, cards"],
    ]);
  });

  it("counts a token parameter only where the data queries are limited by it", () => {
    // uid comes from the token, but the data queries use list_id, which every user gets.
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS uid, id AS list_id FROM lists\n    data: [SELECT * FROM todos WHERE list_id = bucket.list_id]\n")).toEqual([
      ["error", 3, "bucket b, parameters[0] reads the requesting user's token, but not in a way that limits which buckets it gives, so every user gets every bucket it lists"],
    ]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data: [SELECT * FROM lists WHERE owner_id = bucket.user_id OR true]\n")).toEqual([
      ["error", 4, "bucket b: its data queries are not limited by a bucket parameter, so every user it reaches receives every row of lists"],
    ]);
  });

  it("warns, not fails, on open data in a bucket only a role reaches", () => {
    expect(lint("bucket_definitions:\n  admin:\n    parameters: SELECT FROM users WHERE id = request.user_id() AND is_admin = true\n    data: [SELECT * FROM customers]\n")).toEqual([
      [
        "warning",
        4,
        "bucket admin: its data queries are not limited by a bucket parameter, so every user its parameter queries admit receives every row of customers; fine if their checks (such as is_admin = true, or a role claim) admit only users meant to see it all",
      ],
    ]);
    for (const gate of ["SELECT FROM users WHERE users.id = request.user_id() AND users.is_admin", "SELECT WHERE request.jwt() ->> 'role' = 'admin'", "SELECT WHERE token_parameters.is_admin"]) {
      expect(lint(`bucket_definitions:\n  admin:\n    parameters: ${gate}\n    data: [SELECT * FROM customers]\n`).map((f) => f[0]), gate).toEqual(["warning"]);
    }
  });

  it("fails open data behind a gate that is no role: a client value, a claim every token passes, a bucket that also scopes", () => {
    for (const gate of [
      "SELECT FROM users WHERE id = request.user_id() AND request.parameters() ->> 'admin' = 'yes'",
      "SELECT FROM users WHERE id = request.user_id() AND 1 = 1",
      "SELECT WHERE request.jwt() ->> 'role' = 'authenticated'",
      "SELECT WHERE request.jwt() ->> 'is_anonymous' = false",
      "SELECT FROM users WHERE id = request.user_id() AND true",
    ]) {
      expect(lint(`bucket_definitions:\n  b:\n    parameters: ${gate}\n    data: [SELECT * FROM payroll]\n`).map((f) => f[0]), gate).toEqual(["error"]);
    }
    // A membership filter beside a per-org bucket is no role: invoices go to every member of anything.
    expect(
      lint(
        "bucket_definitions:\n  by_org:\n    parameters: SELECT org_id FROM members WHERE user_id = request.user_id() AND accepted = true\n    data:\n      - SELECT * FROM projects WHERE org_id = bucket.org_id\n      - SELECT * FROM invoices\n",
      ),
    ).toEqual([["error", 6, "bucket by_org: 1 of its data queries is not limited by a bucket parameter, so every user it reaches receives every row of invoices"]]);
  });

  it("takes rows picked by a claim every user shares for nobody's, not the client's", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS org_id FROM orgs WHERE public_to = request.jwt() ->> 'role'\n    data: [SELECT * FROM t WHERE org = bucket.org_id]\n").map((f) => f[0])).toEqual([
      "error",
    ]);
  });

  it("takes no claim every user shares for a bucket parameter", () => {
    for (const parameters of [
      "SELECT request.jwt() ->> 'role' AS r",
      "SELECT request.jwt() ->> 'aud' AS r FROM users WHERE id = request.user_id()",
      // A fixed filter on the user's own row still hands everyone the same bucket.
      "SELECT request.jwt() ->> 'role' AS r FROM users WHERE id = request.user_id() AND deleted = false",
    ]) {
      expect(lint(`bucket_definitions:\n  b:\n    parameters: ${parameters}\n    data: [SELECT * FROM t WHERE audience = bucket.r]\n`).map((f) => f[0]), parameters).toEqual(["error"]);
    }
  });

  it("takes no token flag for a filter of rows", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS org_id FROM orgs WHERE token_parameters.is_admin\n    data: [SELECT * FROM t WHERE org = bucket.org_id]\n").map((f) => f[0])).toEqual([
      "error",
    ]);
  });

  it("warns about a parameter query that gives its buckets to whoever passes a role claim", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS org_id FROM orgs WHERE request.jwt() ->> 'role' = 'admin'\n    data: [SELECT * FROM projects WHERE org_id = bucket.org_id]\n")).toEqual([
      [
        "warning",
        3,
        "bucket b, parameters[0] gives every bucket it lists to every user who passes its check on who is asking (a role claim), not each user their own; fine if only users meant to see them all pass it",
      ],
    ]);
    // The token against a client value checks nothing: every bucket goes to everyone.
    expect(
      lint("bucket_definitions:\n  b:\n    parameters: SELECT id AS org_id FROM orgs WHERE request.user_id() = request.parameters() ->> 'uid'\n    data: [SELECT * FROM projects WHERE org_id = bucket.org_id]\n").map(
        (f) => f[0],
      ),
    ).toEqual(["error"]);
  });

  it("accepts a bucket tied to the token, and leaves client parameters to client-scoped", () => {
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.user_id() AS user_id\n    data: [SELECT * FROM lists WHERE owner_id = bucket.user_id]\n")).toEqual([]);
    expect(lint("bucket_definitions:\n  b:\n    parameters: SELECT request.parameters() ->> 'id' AS id\n    data: [SELECT * FROM lists WHERE id = bucket.id]\n")).toEqual([]);
  });
});

describe("unscoped-query on the corpus", () => {
  it("catches every planted leak that expects it", () => {
    const planted = plantedExpecting("unscoped-query");
    expect(planted.map((p) => p.file)).toEqual(["missing-owner-filter.yaml", "unbound-parameter-query.yaml"]);
    for (const p of planted) expect(lintSyncConfig(p.text, p.file, [unscopedQuery]).map((f) => f.level), p.file).toContain(p.level);
  });

  it("finds exactly these in the real configs", () => {
    expect(corpusFindings("real", [unscopedQuery])).toEqual([
      "powersync-dart-trello-global-legacy.yaml:8 error",
      "powersync-dart-trello-legacy.yaml:5 error",
      "powersync-dart-trello-legacy.yaml:14 error",
      "powersync-js-nextjs.yaml:11 error",
    ]);
  });
});
