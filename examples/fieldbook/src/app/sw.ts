import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist } from "serwist";

// Precaches the build's assets and caches visited pages, so the app shell reopens with
// the network off; the data comes from the encrypted local store. A page never visited
// falls back to /~offline. Built by @serwist/turbopack's route handler
// (src/app/serwist/[path]/route.ts); not registered in development.

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Cached pages reference their build's chunks, which the precache drops when a new
// build activates. So pages are cached per build, and older builds' page caches go.
const BUILD_ID =
  (self.__SW_MANIFEST ?? [])
    .map((e) => (typeof e === "string" ? e : e.url))
    .map((url) => /\/_next\/static\/([^/]+)\/_buildManifest\.js$/.exec(url)?.[1])
    .find(Boolean) ?? "dev";
const PAGES_PREFIX = "fieldbook-pages-";
const PAGES_CACHE = `${PAGES_PREFIX}${BUILD_ID}`;
// defaultCache's caches that can hold page payloads tied to a build.
const BUILD_BOUND_CACHES = ["pages", "pages-rsc", "pages-rsc-prefetch", "others"];

/** An app route's HTML: not a build asset, a file, the worker itself, or an RSC payload. */
function isPage(request: Request, url: URL): boolean {
  if (request.mode === "navigate") return true;
  if (request.headers.has("RSC")) return false;
  const path = url.pathname;
  return !/^\/(_next|serwist|@powersync)\//.test(path) && !/\.[a-z0-9]+$/i.test(path);
}

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Supabase (REST, Auth) and PowerSync are other origins, and defaultCache caches
    // cross-origin GETs. Their responses carry tenant data and tokens: never put them
    // in Cache Storage, where they would sit unencrypted beside the encrypted store.
    { matcher: ({ sameOrigin }) => !sameOrigin, handler: new NetworkOnly() },
    // Page HTML: document loads, and the plain GETs SerwistProvider sends for pages
    // reached by client-side navigation (cacheOnNavigation), so those reopen offline too.
    // defaultCache would expire them 24 hours after the server sent them, so a device
    // offline for a day could no longer open the app. Kept for 30 days from last use
    // instead, and a stalled network falls back to the cache after 3 seconds.
    {
      matcher: ({ request, sameOrigin, url }) => sameOrigin && request.method === "GET" && isPage(request, url),
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE,
        networkTimeoutSeconds: 3,
        plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60, maxAgeFrom: "last-used" })],
      }),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [{ url: "/~offline", matcher: ({ request }) => request.destination === "document" }],
  },
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if ((name.startsWith(PAGES_PREFIX) && name !== PAGES_CACHE) || BUILD_BOUND_CACHES.includes(name)) {
          await caches.delete(name);
        }
      }
    })(),
  );
});

serwist.addEventListeners();
