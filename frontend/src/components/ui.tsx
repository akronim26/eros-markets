"use client";

import { useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { Tone } from "@/lib/enums";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

/** Tabular number whose changed characters flip into place; unchanged columns never move. */
export function Num({ value, className }: { value: string; className?: string }) {
  const prev = useRef(value);
  const old = prev.current;
  prev.current = value;
  return (
    <span className={cx("tnum whitespace-nowrap", className)} aria-label={value}>
      {Array.from(value).map((ch, i) => {
        const changed = old !== value && old[i] !== ch;
        return (
          <span key={changed ? `${i}-${ch}-${value}` : `${i}`} aria-hidden className={changed ? "digit-new" : undefined}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

const TONE: Record<Tone, string> = {
  signal: "text-signal-text shadow-[inset_0_0_0_1px_var(--color-signal)]",
  warn: "text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
  neutral: "text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
  bid: "text-bid shadow-[inset_0_0_0_1px_var(--color-bid)]",
  ask: "text-ask shadow-[inset_0_0_0_1px_var(--color-ask)]",
  muted: "text-fg-3 shadow-[inset_0_0_0_1px_var(--color-line)]",
};

export function Chip({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("label inline-flex h-6 items-center gap-1.5 px-2 whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

/** Region header: a mono label row (e.g. ORDER.TICKET) ruled by a hard line. */
export function RegionHead({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex h-9 shrink-0 items-center justify-between gap-3 px-3 shadow-[inset_0_-1px_0_var(--color-line-strong)]", className)}>
      <h2 className="label font-medium text-fg">{title}</h2>
      {children && <div className="label flex items-center gap-2 text-fg-3">{children}</div>}
    </div>
  );
}

/** Section divider: `// SECTION: NAME ———— 004`. The number is a real ordinal of the page's sections. */
export function SectionRule({ name, index }: { name: string; index: number }) {
  return (
    <div className="label flex items-center gap-3 text-fg-3">
      <span>// SECTION: {name}</span>
      <span className="h-px flex-1 bg-line" aria-hidden />
      <span className="tnum">{String(index).padStart(3, "0")}</span>
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "bid" | "ask";
  size?: "sm" | "md" | "lg";
  /** Prefix the label with the Signal arrow square (primary actions). */
  arrow?: boolean;
};

const VARIANT = {
  primary: "bg-action text-on-action hover:bg-action-hover disabled:bg-press disabled:text-fg-4",
  secondary: "text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)] hover:bg-hover active:bg-press disabled:text-fg-4 disabled:hover:bg-transparent",
  ghost: "text-fg-2 hover:bg-hover hover:text-fg active:bg-press disabled:text-fg-4",
  bid: "bg-bid text-on-bid hover:brightness-110 disabled:bg-press disabled:text-fg-4",
  ask: "bg-ask text-on-ask hover:brightness-110 disabled:bg-press disabled:text-fg-4",
};
const SIZE = { sm: "h-7 px-2.5", md: "h-8 px-3", lg: "h-10 px-4" };

export function Button({ variant = "secondary", size = "md", arrow, className, children, ...rest }: BtnProps) {
  const base = "label inline-flex select-none items-center justify-center gap-2 font-medium transition-colors duration-150 disabled:cursor-not-allowed";
  if (arrow) {
    const sq = { sm: "w-7", md: "w-8", lg: "w-10" }[size];
    return (
      <button className={cx("group inline-flex items-stretch disabled:cursor-not-allowed", SIZE[size].split(" ")[0], className)} {...rest}>
        <span className={cx("flex items-center justify-center bg-signal text-on-signal group-disabled:bg-press group-disabled:text-fg-4", sq)} aria-hidden>
          <ArrowRight size={14} strokeWidth={2} />
        </span>
        <span className={cx(base, "flex-1", VARIANT[variant], SIZE[size])}>{children}</span>
      </button>
    );
  }
  return (
    <button className={cx(base, VARIANT[variant], SIZE[size], className)} {...rest}>
      {children}
    </button>
  );
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: "signal" | "bid" | "ask" | "warn" }) {
  const t = tone ? { signal: "text-signal-text", bid: "text-bid", ask: "text-ask", warn: "text-fg" }[tone] : "text-fg";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="label text-fg-3">{label}</span>
      <span className={cx("text-sm font-medium", t)}>{children}</span>
    </div>
  );
}

/**
 * Unknown is stated as a mark, never as zero (frontend.md R4): an outlined box (Signal-outlined for
 * the mark price) followed by a short reason.
 */
export function Unavailable({ reason, short = "unavailable", signal = false }: { reason: string; short?: string; signal?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-3" title={reason}>
      <span
        className={cx("h-2.5 w-2.5 shrink-0", signal ? "shadow-[inset_0_0_0_1px_var(--color-signal)]" : "shadow-[inset_0_0_0_1px_var(--color-fg-3)]")}
        aria-hidden
      />
      <span className="text-sm">{short}</span>
    </span>
  );
}

export function Row({ k, v, hint }: { k: ReactNode; v: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-xs" title={hint}>
      <dt className="text-fg-3">{k}</dt>
      <dd className="tnum text-right text-fg">{v}</dd>
    </div>
  );
}
