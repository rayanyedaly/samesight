/**
 * not-auto-subscribed: a stream devices receive only when the app subscribes to it, with
 * parameters the app chooses. Nothing wrong in itself, so a note: audit does not subscribe
 * to it and so does not test it, and what reaches a device depends on what the app (or
 * anyone calling the API) asks for. Sync rules buckets are always synced, so streams only.
 */

import type { LintRule } from "../lint.ts";

const RULE = "not-auto-subscribed";

export const notAutoSubscribed: LintRule = ({ file, config, lineOf }) =>
  config.kind !== "streams"
    ? []
    : config.streams
        .filter((s) => !s.autoSubscribe)
        .map((s) => ({
          rule: RULE,
          level: "info" as const,
          file,
          line: s.queries[0] ? lineOf(s.queries[0].sql) : undefined,
          subjects: [s.name],
          message: `stream ${s.name} is not auto_subscribe: devices get its rows only when the app subscribes, with the parameters it sends, and audit does not test it`,
        }));
