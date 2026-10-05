"use client";

import Link from "next/link";
import { Button } from "@/components/ui";

export default function MarketError({ reset }: { reset: () => void }) {
  return <main className="mx-auto max-w-2xl px-4 py-16">
    <h1 className="text-2xl font-semibold">Market unavailable</h1>
    <p role="alert" className="mt-4 text-sm text-fg-2">We couldn&apos;t verify this market right now. Check your connection and try again.</p>
    <div className="mt-6 flex flex-wrap items-center gap-4">
      <Button variant="primary" size="lg" onClick={reset}>Try again</Button>
      <Link href="/markets" className="text-sm text-signal-text underline">Back to all markets</Link>
    </div>
  </main>;
}
