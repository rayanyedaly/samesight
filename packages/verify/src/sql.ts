/**
 * Splits a Postgres script into statements, so each can be run and named on failure.
 * A plain split(";") is wrong three ways in a generated migration: comments hold
 * semicolons in prose, literals and quoted names can hold them, and every function body
 * and DO block is a $$ ... $$ region full of them.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment: runs to the end of the line.
    if (rest.startsWith("--")) {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment.
    if (rest.startsWith("/*")) {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    // Single-quoted literal or double-quoted identifier; a doubled quote escapes itself.
    if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === q && sql[j + 1] === q) {
          j += 2;
          continue;
        }
        if (sql[j] === q) break;
        j++;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar-quoted body: $$ ... $$ or $tag$ ... $tag$.
    const dollar = rest.match(/^\$([A-Za-z_]\w*)?\$/);
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }

    if (sql[i] === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      i++;
      continue;
    }

    buf += sql[i];
    i++;
  }

  if (buf.trim()) out.push(buf.trim());
  // Drop fragments that are only comments and whitespace.
  return out.filter((s) => s.split("\n").some((l) => l.trim() && !l.trim().startsWith("--")));
}
