"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Button } from "./ui";
import { COOKIE_NOTICE_EVENT } from "./site-footer";

const KEY = "eros-cookie-notice-v1";
const MAX_AGE = 180 * 24 * 60 * 60 * 1000;

/** Informational notice, not consent for tracking. No optional trackers are configured. */
export function CookieBanner() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const acknowledged = () => {
      try { const at = Number(localStorage.getItem(KEY)); return at > 0 && at <= Date.now() && Date.now() - at < MAX_AGE; } catch { return false; }
    };
    setOpen(!acknowledged());
    const show = () => { restore.current = document.activeElement as HTMLElement; setOpen(true); panel.current?.focus(); };
    const sync = (event: StorageEvent) => { if (event.key === KEY || event.key === null) setOpen(!acknowledged()); };
    window.addEventListener(COOKIE_NOTICE_EVENT, show);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(COOKIE_NOTICE_EVENT, show); window.removeEventListener("storage", sync); };
  }, []);
  useEffect(() => { if (open && restore.current) panel.current?.focus(); }, [open]);
  function dismiss() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* Dismiss for this page session when storage is blocked. */ }
    setOpen(false);
    if (restore.current?.isConnected) restore.current.focus();
  }
  if (!open) return null;
  return <aside ref={panel} tabIndex={-1} aria-labelledby="cookie-title" className="fixed inset-x-3 bottom-3 z-40 mx-auto max-h-[70dvh] max-w-3xl overflow-y-auto border border-line-strong bg-ground p-4 shadow-lg sm:p-5" onKeyDown={(e) => { if (e.key === "Escape") dismiss(); }}>
    <div className="flex items-center gap-3"><ShieldCheck size={19} className="text-signal-text" aria-hidden /><h2 id="cookie-title" className="text-sm font-semibold">A note on cookies & storage</h2></div>
    <p className="mt-3 text-xs leading-relaxed text-fg-2">Sign-in and wallet services use browser storage. Eros also remembers your theme and recent order IDs on this device. We haven’t added advertising or optional analytics tools.</p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><Link href="/privacy#browser-storage" className="inline-flex min-h-11 items-center text-xs underline underline-offset-4">How storage is used</Link><Button variant="primary" className="min-h-11 px-6" onClick={dismiss}>Got it</Button></div>
  </aside>;
}
