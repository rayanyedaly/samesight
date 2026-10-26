/**
 * A hand-written sync config, in either form PowerSync reads: Edition 3 sync streams
 * (`streams:`) or the earlier sync rules (`bucket_definitions:`). Both come out as
 * Stream entries, which is all audit mode needs: the queries whose rows land on devices,
 * and the queries that only decide which rows (stream CTEs, bucket parameter queries).
 *
 * Bucket definitions sync without being asked for, so each counts as auto-subscribed.
 */

import { parse } from "yaml";
import type { Finding } from "../doctor.ts";
import { parseStreams, type Stream } from "./streams.ts";

export interface SyncConfig {
  kind: "streams" | "bucket definitions";
  streams: Stream[];
  /** Warnings about what the run cannot exercise. */
  findings: Finding[];
}

const RULES_TOP_LEVEL = new Set(["config", "bucket_definitions", "event_definitions"]);
const DEFINITION_KEYS = new Set(["parameters", "data", "priority", "accept_potentially_dangerous_queries"]);
/**
 * Client parameters: whatever the app passes when it connects, so whatever an attacker
 * passes. request.parameters(), and user_parameters.x in older sync rules.
 */
const CLIENT_PARAMETERS = /\brequest\s*\.\s*parameters\s*\(|\buser_parameters\s*\.|\b(connection|subscription)\s*\.\s*parameters?\s*\(/i;

function clientParameters(name: string, sql: string[]): Finding[] {
  if (!sql.some((q) => CLIENT_PARAMETERS.test(q))) return [];
  return [
    {
      status: "warn",
      check: "sync config",
      detail: `${name} reads client parameters (connection.parameter(), subscription.parameter(), request.parameters() or user_parameters), which the client chooses; devices here send none, so the run does not try what a client could ask for. Never let client parameters decide access.`,
    },
  ];
}

export function parseSyncConfig(yaml: string): SyncConfig {
  const doc = parse(yaml) as unknown;
  if (!isObject(doc)) throw new Error("the sync config is not a YAML mapping");
  if (doc.streams !== undefined && doc.bucket_definitions !== undefined) {
    throw new Error("the sync config has both streams and bucket_definitions; audit mode reads one or the other");
  }
  if (doc.bucket_definitions === undefined) {
    const streams = parseStreams(yaml);
    return { kind: "streams", streams, findings: streams.flatMap((st) => clientParameters(st.name, [...st.ctes.values(), ...st.queries.map((q) => q.sql)])) };
  }

  const unknown = Object.keys(doc).filter((k) => !RULES_TOP_LEVEL.has(k));
  if (unknown.length) throw new Error(`the sync config has ${unknown.join(", ")}, which audit mode does not read`);
  if (!isObject(doc.bucket_definitions)) throw new Error("bucket_definitions is not a mapping");
  const findings: Finding[] = [];
  const streams = Object.entries(doc.bucket_definitions).map(([name, d]): Stream => {
    if (!isObject(d)) throw new Error(`bucket definition ${name} is not a mapping`);
    const extra = Object.keys(d).filter((k) => !DEFINITION_KEYS.has(k));
    if (extra.length) throw new Error(`bucket definition ${name} has ${extra.join(", ")}, which audit mode does not read`);
    const parameters = sqlList(name, "parameters", d.parameters ?? []);
    const data = sqlList(name, "data", d.data);
    if (data.length === 0) throw new Error(`bucket definition ${name} has no data queries`);
    findings.push(...clientParameters(name, [...parameters, ...data]));
    return {
      name,
      autoSubscribe: true,
      ctes: new Map(parameters.map((sql, n) => [`parameters[${n}]`, sql])),
      queries: data.map((sql, n) => ({ label: `data[${n}]`, sql })),
    };
  });
  return { kind: "bucket definitions", streams, findings };
}

function sqlList(definition: string, key: string, value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((q) => typeof q === "string")) return value as string[];
  throw new Error(`bucket definition ${definition}: ${key} must be a SQL string or a list of them`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
