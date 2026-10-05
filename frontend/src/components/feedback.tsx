"use client";

import { useId, useState } from "react";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { Button } from "./ui";

export function FieldError({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return <span id={id} role="alert" className="flex items-start gap-2 text-xs leading-relaxed normal-case tracking-normal text-ask"><AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />{children}</span>;
}

/** Errors are revealed on blur (or submit), then update as the user corrects a field. */
export function useFieldErrors(errors: Record<string, string>) {
  const id = useId();
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const message = (name: string) => touched[name] ? errors[name] : "";
  const errorId = (name: string) => `${id}-${name}-error`;
  return {
    message, errorId,
    touch: (name: string) => setTouched((old) => ({ ...old, [name]: true })),
    reset: () => setTouched({}),
    reveal: () => {
      setTouched(Object.fromEntries(Object.keys(errors).map((name) => [name, true])));
      const first = Object.keys(errors).find((name) => errors[name]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return !first;
    },
    props: (name: string) => ({ id: `${id}-${name}`, "aria-invalid": !!message(name), "aria-describedby": message(name) ? errorId(name) : undefined, onBlur: () => setTouched((old) => ({ ...old, [name]: true })) }),
  };
}

export function PendingState({ children }: { children: React.ReactNode }) {
  return <p role="status" className="flex items-center gap-2 text-sm text-fg-3"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none shrink-0" aria-hidden />{children}</p>;
}

export function LoadingPanel({ label = "Loading market data" }: { label?: string }) {
  return <div className="space-y-5 border border-line p-5" aria-busy="true">
    <PendingState>{label}…</PendingState>
    <div aria-hidden className="space-y-3 motion-safe:animate-pulse">
      <div className="h-5 w-2/3 bg-press" /><div className="h-3 w-1/2 bg-press" />
      <div className="grid grid-cols-3 gap-3 pt-3">{[0, 1, 2].map((n) => <div key={n} className="h-16 bg-press" />)}</div>
    </div>
  </div>;
}

export function PageLoading({ title = "Loading your view" }: { title?: string }) {
  return <main className="mx-auto min-h-[60vh] w-full max-w-[1280px] px-4 py-12 md:px-8"><h1 className="pixel mb-8 text-3xl uppercase">{title}</h1><LoadingPanel label="Connecting to Eros Markets" /></main>;
}

export function ReadError({ message, retry }: { message: string; retry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-ask/40 bg-panel p-4"><p className="flex items-start gap-2 text-sm text-ask"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />{message}</p><Button className="min-h-11" onClick={retry}>Try again</Button></div>;
}
