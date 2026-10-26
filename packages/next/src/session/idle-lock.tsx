"use client";

import { useEffect, useRef } from "react";

/**
 * Lock the store after a period with no interaction, so an unattended device does not
 * sit with data on screen and the key in memory.
 *
 * It LOCKS, it never wipes: forgetting the key makes the store unreadable without the
 * password, and the unsynced writes still exist when the person comes back. A wipe here
 * would let fifteen minutes away from the device destroy work that never reached the
 * server. It also needs no network, so it works offline, and the unlock screen reopens
 * the same store offline. Renders nothing.
 */
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

export function IdleLock({ onLock, idleMs = DEFAULT_IDLE_MS }: { onLock: () => void; idleMs?: number }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockRef = useRef(onLock);
  lockRef.current = onLock;

  useEffect(() => {
    let locked = false;
    // Timers pause while the device sleeps or the tab is suspended, so the time since the
    // last input is also checked by the clock whenever the page comes back or is touched.
    let last = Date.now();
    function lock() {
      if (locked) return;
      locked = true;
      lockRef.current();
    }
    function reset() {
      if (Date.now() - last >= idleMs) return lock();
      last = Date.now();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(lock, idleMs);
    }
    function check() {
      if (Date.now() - last >= idleMs) lock();
    }
    // Capture phase, so scrolling inside an element (which does not bubble) counts too.
    const events = ["pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true, capture: true });
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    reset();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const e of events) window.removeEventListener(e, reset, { capture: true });
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
    };
  }, [idleMs]);

  return null;
}
