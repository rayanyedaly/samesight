/**
 * unreadable-query: a query `samesight-verify audit` cannot attribute to one table, so the
 * audit refuses it rather than guess what devices hold. A warning, not an error: the query
 * may be fine, but nothing checks it until it is rewritten into a shape audit reads (a
 * qualified projection, [INNER] JOIN ... ON, no renamed table).
 */

import { outputTable, tablesNamed } from "../../sync/scope.ts";
import { tokenize } from "../../sync/sql.ts";
import type { LintFinding } from "../finding.ts";
import { defineRule, type LintRule } from "../lint.ts";

const RULE = "unreadable-query";

export const unreadableQuery: LintRule = defineRule(RULE, ({ file, config, lineOf }) => {
  const out: LintFinding[] = [];
  const kind = config.kind === "streams" ? "stream" : "bucket";
  const add = (sql: string, name: string, where: string, reason: string) =>
    out.push({ rule: RULE, level: "warning", file, line: lineOf(sql), message: `${kind} ${name}, ${where} cannot be checked by audit: it ${reason}`, subjects: [name] });

  for (const s of config.streams) {
    // CTEs and parameter queries only need their tables named; queries must map to one table.
    for (const [name, sql] of s.ctes) {
      try {
        tokenize(sql);
        tablesNamed(sql);
      } catch (e) {
        add(sql, s.name, config.kind === "streams" ? `with.${name}` : name, (e as Error).message);
      }
    }
    for (const q of s.queries) {
      try {
        outputTable(q.sql);
      } catch (e) {
        add(q.sql, s.name, q.label, (e as Error).message);
      }
    }
  }
  return out;
});
