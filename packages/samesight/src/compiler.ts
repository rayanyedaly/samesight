/**
 * The compiler's internals, for @samesight/verify: the IR, the emitters, the generate
 * plan and the local-only database access. Not a stable API before 1.0.
 */

export {
  type ClaimClass,
  type ClaimDialect,
  type ClaimOptions,
  type ClaimRead,
  type ClaimReads,
  type ClaimValue,
  type Compared,
  AUTH_STATE_KEYS,
  authStateKey,
  BODY_JOIN,
  callsIn,
  claimReads,
  codeOnly,
  classify,
  type Unreadable,
  wrapperRead,
} from "./claims.ts";
export { emitClientSchema, emitManifest, emitPolicyTypes, emitServiceConfig } from "./emit/client.ts";
export { ident, literal } from "./emit/expr.ts";
export { emitMigration, PUBLICATION, REPLICATION_ROLE } from "./emit/migration.ts";
export { emitSyncConfig } from "./emit/sync.ts";
export { DEFAULT_OUTPUT, outputPaths, type Plan, plan } from "./generate.ts";
export { assertLocal, DEFAULT_DB_URL, introspect, projectDbUrl, withLocalClient } from "./introspect.ts";
export { buildIR, CompileError, type IR, type IRTable, type Rule, snake } from "./ir.ts";
export { loadPolicy, POLICY_FILES, resolvePolicyPath } from "./load.ts";
export { explainPolicy } from "./explain.ts";
export { readSupabaseConfig, type SupabaseConfig } from "./supabase-config.ts";
export type { ColumnInfo, ForeignKey, SchemaInfo, TableInfo } from "./schema.ts";
export { parseSyncConfig, type SyncConfig } from "./sync/config.ts";
export { type ParsedQuery, parseQuery, render, sqlText, type Token, type TokenizeOptions, tokenize } from "./sync/sql.ts";
export { parseStreams, type Stream } from "./sync/streams.ts";
export { type AuditScope, auditScope, outputTable, tablesNamed } from "./sync/scope.ts";
