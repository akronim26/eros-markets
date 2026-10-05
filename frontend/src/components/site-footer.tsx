"use client";

import Link from "next/link";
import { BrandImage } from "./brand-image";

export const COOKIE_NOTICE_EVENT = "eros:cookie-notice";

export function SiteFooter() {
  return <footer className="border-t border-line-strong">
    <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-6 px-4 py-7 md:px-8">
      <div><Link href="/" aria-label="Eros Markets home"><BrandImage className="w-32" /></Link><p className="mt-3 text-xs text-fg-3">© 2026 Eros Markets · Monad testnet</p></div>
      <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-fg-2">
        <Link className="inline-flex min-h-11 items-center hover:underline" href="/markets">Markets</Link>
        <Link className="inline-flex min-h-11 items-center hover:underline" href="/privacy">Privacy</Link>
        <Link className="inline-flex min-h-11 items-center hover:underline" href="/terms">Terms</Link>
        <button type="button" className="min-h-11 cursor-pointer hover:underline" onClick={() => window.dispatchEvent(new Event(COOKIE_NOTICE_EVENT))}>Cookies & storage</button>
      </nav>
    </div>
  </footer>;
}
