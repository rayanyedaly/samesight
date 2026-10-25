"use client";

import { SerwistProvider } from "@serwist/turbopack/react";
import { type ReactNode, useEffect } from "react";

const DEV = process.env.NODE_ENV === "development";

// Registers the service worker in production builds only: in development it would
// serve stale bundles across edits, so there a worker left over from `start` is removed.
// No reload when the connection returns (Serwist's default): the store key lives only
// in memory, so a reload locks the app and drops unsaved input every time signal flickers.
export function ServiceWorker({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (!DEV || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
  }, []);
  return (
    <SerwistProvider swUrl="/serwist/sw.js" disable={DEV} reloadOnOnline={false}>
      {children}
    </SerwistProvider>
  );
}
