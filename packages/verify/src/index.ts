/**
 * @samesight/verify is mainly its CLI, `samesight-verify`. These are its offline checks,
 * which need no database or PowerSync, for use in a project's own tests. Not a stable API
 * before 1.0.
 */

export { exitCode, failed, type Finding, formatFindings, formatRow, type RowReport } from "./report.ts";
export { checkClientSchema, readClientSchema } from "./static/client-schema.ts";
export { checkManifest, type Manifest } from "./static/manifest.ts";
export { parseStreams, type Stream } from "samesight/compiler";
export { checkStreams } from "./static/streams.ts";
export { checkVersionFloor, VERSION_FLOOR } from "./static/version-floor.ts";
