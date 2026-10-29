/**
 * personal-columns: a column that likely holds personal data, sent to users other than the
 * row's owner.
 *
 * Read from the exposure map (exposure/map.ts), by the widest audience of each query: a column
 * counts by the whole words of its name or a samesight marker in its comment
 * (exposure/personal.ts), never by its data. Rows a group's members get, or every user for the
 * rows a fixed filter picks, are often shared on purpose, so a warning says what to decide.
 * Rows a role check admits are often meant for admins, and unscoped-query or client-scoped
 * usually fail a query whose rows any client or every user gets, so those are notes: they keep
 * the column in view when that finding is accepted with --allow. Queries the map cannot read
 * are unreadable-query's. A * sends whatever columns the table has, which only the migrations
 * tell; without them only the listed columns count.
 */

import { type ExposedColumn, type ExposedQuery, exposureMap, type Schema } from "../../exposure/map.ts";
import type { PersonalCategory, PersonalMatch } from "../../exposure/personal.ts";
import { AUDIENCE_ORDER, type Audience, audienceText } from "../audience.ts";
import type { LintFinding, LintLevel } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";

const RULE = "personal-columns";

/** Each audience wider than the row's owner. */
const LEVEL: Record<Exclude<Audience["kind"], "owner">, LintLevel> = { group: "warning", fixed: "warning", role: "info", client: "info", everyone: "info" };

const rank = (a: Audience) => AUDIENCE_ORDER.indexOf(a.kind);

/** What a column of each category holds, for messages. */
const HOLDS: Record<PersonalCategory, string> = {
  identifier: "identifying data",
  contact: "contact data",
  location: "location data",
  birth: "a birth date or age",
  health: "health data",
  financial: "financial data",
  secret: "a secret",
  "free text": "free text about a person",
  personal: "personal data",
};

/** Why the column counts: likely, by its name or the JSON key it reads, or as its comment marks it. */
function why(p: PersonalMatch, jsonKey: string | undefined): string {
  if (p.source === "comment") return `${HOLDS[p.category]}, marked in its comment`;
  return `likely ${HOLDS[p.category]}, by ${jsonKey === undefined ? "its name" : `the JSON key '${jsonKey}' it reads`}`;
}

/**
 * A query's level: by its widest audience, except that a bucket a group's members or a fixed
 * filter reaches through one parameter query warns even when a role check reaches it through
 * another. A query every user or any client gets is unscoped-query's or client-scoped's error.
 */
function level(q: ExposedQuery): LintLevel {
  const widest = q.audience.kind;
  if (widest === "owner" || widest === "everyone" || widest === "client") return "info";
  return q.paths.some((p) => p.audience.kind === "group" || p.audience.kind === "fixed") ? "warning" : LEVEL[widest];
}

/** "a", "a and b", "a, b and c". */
const list = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** Who gets the rows, after "to"; a client's choice names rows, not users. */
const to = (a: Audience) => (a.kind === "client" ? "any client, for whichever rows it asks for" : audienceText(a));

/**
 * The table's columns a sent column reads, as table.column (its own name when it reads none),
 * and how the message names it: with its name on the device too when renamed or derived.
 */
function sent(table: string, c: ExposedColumn): { columns: string[]; text: string } {
  const columns = (c.from.length ? [...new Set(c.from)] : [c.name]).map((f) => `${table}.${f}`);
  const same = !c.derived && c.from.length === 1 && c.from[0] === c.name;
  return { columns, text: same ? list(columns) : `${list(columns)} as ${c.name}` };
}

export const personalColumns: LintRule = defineRule(RULE, ({ file, config, migrations, lineOf }) => {
  const schema: Schema | undefined = migrations ? (table) => migrations.tables.get(table) : undefined;
  const map = exposureMap(config, schema);
  const kind = map.kind === "streams" ? "stream" : "bucket";
  const out: LintFinding[] = [];
  for (const { table, queries } of map.tables) {
    for (const q of queries) {
      if (q.audience.kind === "owner") continue;
      // A bucket's ways in, each beyond the owner (its group path besides its role check), widest
      // first; else the query's one audience. Owners named by different columns are a group.
      const paths = q.paths.length > 1 ? [...new Set(q.paths.map((p) => p.audience).filter((a) => a.kind !== "owner").sort((x, y) => rank(y) - rank(x)).map(to))] : [];
      const reach = paths.length ? paths : [to(q.audience)];
      const fine = level(q) === "info" && q.audience.kind === "role" ? "fine if only users meant to see it (such as admins) pass that check" : "fine if they need it";
      for (const c of q.columns.items) {
        if (!c.personal) continue;
        const { columns, text } = sent(table, c);
        out.push({
          rule: RULE,
          level: level(q),
          file,
          ...lineOf(q.sql),
          subjects: [q.stream, table, ...columns],
          message: `${kind} ${q.stream}, ${q.query} sends ${text} (${why(c.personal, c.jsonKey)}) to ${reach.join(", and to ")}, not only the row's owner; ${fine}, else drop it from the query`,
        });
      }
    }
  }
  return out;
});
