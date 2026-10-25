import { createSerwistRoute } from "@serwist/turbopack";

// Builds and serves the service worker (/serwist/sw.js) from src/app/sw.ts.
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  swSrc: "src/app/sw.ts",
  globPatterns: [
    // Serwist's defaults.
    ".next/static/**/*.{js,css,html,ico,apng,png,avif,jpg,jpeg,jfif,pjpeg,pjp,gif,svg,webp,json,webmanifest}",
    "public/*",
    // PowerSync's database worker and, of its four SQLite builds, the one an encrypted
    // IndexedDB store loads. Without them the store cannot open offline.
    "public/@powersync/*.js",
    "public/@powersync/assets/mc-wa-sqlite-async-*.wasm",
  ],
  // The offline fallback must be precached: it is shown exactly when the network is not there.
  additionalPrecacheEntries: [{ url: "/~offline", revision: crypto.randomUUID() }],
  // That SQLite build is about 2.4 MB, over the 2 MiB default.
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
  useNativeEsbuild: true,
});
