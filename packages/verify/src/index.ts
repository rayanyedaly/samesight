/**
 * @samesight/verify is mainly its CLI, `samesight-verify`. These are its offline checks,
 * which need no database or PowerSync, for use in a project's own tests. Not a stable API
 * before 1.0.
 */

export { failed, type Finding, formatFindings } from "./report.ts";
export { checkClientSchema, readClientSchema } from "./static/client-schema.ts";
export { checkManifest, type Manifest } from "./static/manifest.ts";
export { checkStreams, parseStreams, type Stream } from "./static/streams.ts";
export { checkVersionFloor, VERSION_FLOOR } from "./static/version-floor.ts";
