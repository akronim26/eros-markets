"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";

export default function MarketError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // Keep the cause visible so a wallet-specific failure can be diagnosed from the console or the page.
  useEffect(() => { console.error("Market terminal failed to render:", error); }, [error]);
  return <main className="mx-auto max-w-2xl px-4 py-16">
    <h1 className="text-2xl font-semibold">Market unavailable</h1>
    <p role="alert" className="mt-4 text-sm text-fg-2">We couldn&apos;t verify this market right now. Check your connection and try again.</p>
    <div className="mt-6 flex flex-wrap items-center gap-4">
      <Button variant="primary" size="lg" onClick={() => retry()}>Try again</Button>
      <Link href="/markets" className="text-sm text-signal-text underline">Back to all markets</Link>
    </div>
    <details className="mt-8 text-xs text-fg-3">
      <summary className="cursor-pointer">Technical details</summary>
      <p className="tnum mt-2 break-words">{error.message || "Unknown error"}{error.digest ? ` · digest ${error.digest}` : ""}</p>
    </details>
  </main>;
}
