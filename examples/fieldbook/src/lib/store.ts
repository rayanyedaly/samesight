import { createEncryptedStore } from "@samesight/next";
import { AppSchema } from "./powersync/schema";

// One encrypted local database per user (fieldbook.<userId>.db), keyed from the
// sign-in password. The database worker is PowerSync's prebuilt one, copied to
// public/@powersync by `pnpm assets`: Turbopack's production build copies the worker
// @powersync/web references without bundling its imports, so it cannot start.
export const store = createEncryptedStore({ schema: AppSchema, prefix: "fieldbook", worker: "/@powersync/worker.js" });
