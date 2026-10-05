"use client";
import Link from "next/link";
import { ReadError } from "@/components/feedback";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="mx-auto min-h-[60vh] max-w-3xl px-4 py-16"><p className="label text-signal-text">Page unavailable</p><h1 className="pixel mt-4 mb-6 text-4xl uppercase">Let’s try that again.</h1><ReadError message="This page couldn’t load. Your wallet is still controlled by you. If you submitted a transaction, check its status before trying it again." retry={reset} /><Link href="/markets" className="mt-6 inline-flex min-h-11 items-center text-sm underline">Back to markets →</Link></main>;
}
