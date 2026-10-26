/**
 * The compiler's internals, for @samesight/verify: the IR, the emitters, the generate
 * plan and the local-only database access. Not a stable API before 1.0.
 */

export { emitClientSchema, emitManifest, emitPolicyTypes, emitServiceConfig } from "./emit/client.ts";
export { ident, literal } from "./emit/expr.ts";
export { emitMigration, PUBLICATION, REPLICATION_ROLE } from "./emit/migration.ts";
export { emitSyncConfig } from "./emit/sync.ts";
export { DEFAULT_OUTPUT, outputPaths, type Plan, plan } from "./generate.ts";
export { assertLocal, DEFAULT_DB_URL, introspect, withLocalClient } from "./introspect.ts";
export { buildIR, CompileError, type IR, type IRTable, type Rule, snake } from "./ir.ts";
export { loadPolicy, POLICY_FILES, resolvePolicyPath } from "./load.ts";
export { explainPolicy } from "./explain.ts";
export type { ColumnInfo, ForeignKey, SchemaInfo, TableInfo } from "./schema.ts";
