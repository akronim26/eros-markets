import Link from "next/link";
import type { ReactNode } from "react";

export function LegalPage({ eyebrow, title, intro, sections }: { eyebrow: string; title: string; intro: string; sections: { id: string; title: string; body: ReactNode }[] }) {
  return <main className="mx-auto max-w-[1280px] px-4 py-12 md:px-8 md:py-16">
    <p className="label text-signal-text">{eyebrow} / Updated 6 October 2026</p>
    <h1 className="pixel mt-5 text-[clamp(2.5rem,7vw,5.5rem)] leading-none uppercase">{title}</h1>
    <p className="mt-6 max-w-2xl text-sm leading-relaxed text-fg-2">{intro}</p>
    <div className="mt-12 grid gap-10 border-t border-line-strong pt-6 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
      <nav aria-label="On this page" className="self-start md:sticky md:top-24"><p className="label mb-3 text-fg-3">On this page</p><ol className="space-y-1">{sections.map((section, index) => <li key={section.id}><a className="flex min-h-11 items-center gap-3 text-xs text-fg-2 hover:text-signal-text" href={`#${section.id}`}><span className="text-fg-3">{String(index + 1).padStart(2, "0")}</span>{section.title}</a></li>)}</ol></nav>
      <div className="max-w-3xl space-y-10">{sections.map((section) => <section id={section.id} key={section.id} className="scroll-mt-32 border-b border-line pb-8"><h2 className="text-lg font-semibold">{section.title}</h2><div className="mt-4 space-y-4 text-sm leading-7 text-fg-2 [&_a]:underline [&_a]:underline-offset-4 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-2">{section.body}</div></section>)}<Link href="/markets" className="inline-flex min-h-11 items-center text-sm text-signal-text underline">Back to markets →</Link></div>
    </div>
  </main>;
}
