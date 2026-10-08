"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Point } from "@/lib/reads";
import { priceSegments } from "@/lib/price-chart";
import { cx } from "./ui";

const RANGES = [{ label: "Live", seconds: 900 }, { label: "1H", seconds: 3600 }, { label: "6H", seconds: 21600 }, { label: "1D", seconds: 86400 }, { label: "All", seconds: Infinity }] as const;
const timeLabel = (t: number, long = false) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(long ? { second: "2-digit" } : {}) });
const priceLabel = (p: number) => p.toFixed(3);

type Props = {
  index: Point[];
  perp: Point[];
  markUnit?: number;
  indexUnit?: number;
  emptyTitle: string;
  emptyReason: string;
  historyStatus: string;
  readError?: boolean;
};

/** Historical points are authenticated source observations, not reconstructed mark prices. */
export function PriceAxis(p: Props) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(286);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [range, setRange] = useState(0);
  const [book, setBook] = useState(false);
  const [mark, setMark] = useState(true);
  const [hoverTime, setHoverTime] = useState<number>();
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => { setWidth(entry.contentRect.width); setHeight(Math.max(240, Math.floor(entry.contentRect.height))); });
    if (ref.current) ro.observe(ref.current);
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => { ro.disconnect(); clearInterval(timer); };
  }, []);
  const model = useMemo(() => {
    const end = Math.max(now, p.index.at(-1)?.t ?? 0, p.perp.at(-1)?.t ?? 0);
    const start = range === 4 ? Math.min(p.index[0]?.t ?? end - 900, ...(book && p.perp.length ? [p.perp[0].t] : []), end - 60) : end - RANGES[range].seconds;
    const index = p.index.filter(v => v.t >= start && v.t <= end);
    const perp = book ? p.perp.filter(v => v.t >= start && v.t <= end) : [];
    const indexSegments = priceSegments(index), perpSegments = priceSegments(perp);
    const availableIndex = index.filter(v => v.valid !== false), availablePerp = perp.filter(v => v.valid !== false);
    const values = [...availableIndex.map(v => v.v), ...availablePerp.map(v => v.v), ...(mark && p.markUnit !== undefined ? [p.markUnit] : [])];
    const min = values.length ? Math.min(...values) : Math.max(0, (p.indexUnit ?? 0.5) - 0.05);
    const max = values.length ? Math.max(...values) : Math.min(1, (p.indexUnit ?? 0.5) + 0.05);
    const padding = Math.max((max - min) * 0.2, 0.002);
    return { start, end, index: availableIndex, perp: availablePerp, indexSegments, perpSegments, lo: Math.max(0, min - padding), hi: Math.min(1, max + padding) };
  }, [p.index, p.perp, p.markUnit, p.indexUnit, range, now, book, mark]);
  const left = 14, right = Math.max(left + 1, width - 62), top = 18, bottom = height - 32;
  const x = (t: number) => left + (t - model.start) / (model.end - model.start) * (right - left);
  const y = (v: number) => bottom - (v - model.lo) / (model.hi - model.lo) * (bottom - top);
  const path = (segments: Point[][]) => segments.map(points => points.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(2)},${y(pt.v).toFixed(2)}`).join(" ")).join(" ");
  const last = model.index.at(-1);
  const fresh = !!last && now - last.t <= 30 && last.t <= now + 2 && p.index.at(-1)?.valid !== false && !p.readError;
  const hovered = hoverTime === undefined ? undefined : model.index.reduce<Point | undefined>((a, b) => !a || Math.abs(b.t - hoverTime) < Math.abs(a.t - hoverTime) ? b : a, undefined);
  const selected = hovered ?? last;
  const change = last && model.index.length > 1 ? last.v - model.index[0].v : undefined;
  const pointer = (clientX: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (bounds) setHoverTime(model.start + Math.max(0, Math.min(1, (clientX - bounds.left - left) / (right - left))) * (model.end - model.start));
  };
  return (
    <section aria-label="Index price chart" className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line px-3">
        <h2 className="text-xs font-medium">Chart <span className="ml-2 font-normal text-fg-3">YES · Polymarket</span></h2>
        <span className={cx("inline-flex items-center gap-1.5 text-2xs", fresh ? "text-bid" : "text-fg-3")}><span className={cx("h-1.5 w-1.5", fresh ? "bg-bid" : "bg-fg-4")} aria-hidden />{p.readError ? "Reconnecting" : fresh ? "Live" : last ? "Delayed" : "Connecting"}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="tnum text-2xl font-medium tracking-tight" data-testid="chart-price">{selected ? priceLabel(selected.v) : "—"}</span>
          {!hovered && change !== undefined && <span className={cx("tnum text-xs", change >= 0 ? "text-bid" : "text-ask")}>{change >= 0 ? "+" : ""}{(change * 100).toFixed(2)} pp</span>}
        </div>
        <div role="group" aria-label="Chart time range" className="flex gap-0.5">{RANGES.map((r, i) => <button key={r.label} aria-pressed={range === i} onClick={() => { setRange(i); setHoverTime(undefined); }} className={cx("tnum min-h-9 min-w-9 px-2 text-xs transition-colors", range === i ? "bg-press text-fg" : "text-fg-3 hover:bg-panel hover:text-fg")}>{r.label}</button>)}</div>
      </div>
      <div ref={ref} className="relative min-h-64 min-w-0 flex-1">
        {width > 0 && <svg width={width} height={height} role="img" tabIndex={0} aria-label="Index price over time. Use left and right arrow keys to inspect observations; Escape to return to live."
          className="absolute inset-0 touch-pan-y outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-signal"
          onPointerMove={e => pointer(e.clientX)} onPointerDown={e => pointer(e.clientX)} onPointerLeave={() => setHoverTime(undefined)} onBlur={() => setHoverTime(undefined)}
          onKeyDown={e => {
            if (e.key === "Escape") { setHoverTime(undefined); return; }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || !model.index.length) return;
            e.preventDefault();
            const current = hovered ? model.index.indexOf(hovered) : model.index.length - 1;
            const next = e.key === "Home" ? 0 : e.key === "End" ? model.index.length - 1 : Math.max(0, Math.min(model.index.length - 1, current + (e.key === "ArrowLeft" ? -1 : 1)));
            setHoverTime(model.index[next].t);
          }}>
          <defs><clipPath id={`${id}-plot`}><rect x={left} y={top - 8} width={right - left} height={bottom - top + 16} /></clipPath></defs>
          {Array.from({ length: 5 }, (_, i) => model.lo + (model.hi - model.lo) * i / 4).map(v => <g key={v}>
            <line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeDasharray="2 5" />
            <text x={width - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--color-fg-3)" className="tnum">{priceLabel(v)}</text>
          </g>)}
          {Array.from({ length: width < 400 ? 3 : 5 }, (_, i) => i).map((_, i, ticks) => {
            const t = model.start + (model.end - model.start) * i / (ticks.length - 1);
            return <text key={i} x={x(t)} y={height - 7} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} fontSize={10} fill="var(--color-fg-4)" className="tnum">{model.end - model.start > 86400 ? new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : timeLabel(t)}</text>;
          })}
          <g clipPath={`url(#${id}-plot)`}>
            {mark && p.markUnit !== undefined && <line x1={left} x2={right} y1={y(p.markUnit)} y2={y(p.markUnit)} stroke="var(--color-fg-3)" strokeDasharray="5 5"><title>Current mark {priceLabel(p.markUnit)}; this is not historical mark data.</title></line>}
            <path d={path(model.perpSegments)} fill="none" stroke="var(--color-fg-3)" strokeWidth={1.5} />
            <path d={path(model.indexSegments)} fill="none" stroke="var(--color-signal)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {model.indexSegments.map(segment => segment[0]).map(pt => <circle key={`${pt.t}-${pt.block}`} cx={x(pt.t)} cy={y(pt.v)} r={2} fill="var(--color-signal)" />)}
            {last && <g><circle cx={x(last.t)} cy={y(last.v)} r={fresh ? 7 : 4} fill="var(--color-signal)" opacity={0.15} className={fresh ? "motion-safe:animate-pulse" : ""} /><circle cx={x(last.t)} cy={y(last.v)} r={3} fill="var(--color-signal)" /></g>}
            {hovered && <g><line x1={x(hovered.t)} x2={x(hovered.t)} y1={top} y2={bottom} stroke="var(--color-fg-4)" strokeDasharray="3 3" /><line x1={left} x2={right} y1={y(hovered.v)} y2={y(hovered.v)} stroke="var(--color-fg-4)" strokeDasharray="3 3" /><circle cx={x(hovered.t)} cy={y(hovered.v)} r={5} fill="var(--color-signal)" stroke="var(--color-ground)" strokeWidth={2} /></g>}
          </g>
        </svg>}
        {!last && <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6"><div className="max-w-xs bg-ground/90 px-4 py-3 text-center"><p className="text-sm font-medium">{p.emptyTitle}</p><p className="mt-1 text-xs text-fg-3">{p.emptyReason}</p></div></div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-line px-3 text-2xs text-fg-3">
        <span title={p.historyStatus}>{hovered ? new Date(hovered.t * 1000).toLocaleString() : last ? `Updated ${timeLabel(last.t, true)}` : "No observations yet"}</span>
        <div className="flex gap-3"><button aria-pressed={book} onClick={() => setBook(!book)} className={cx("min-h-9", book && "text-fg")}><span aria-hidden>{book ? "●" : "○"}</span> Book</button><button aria-pressed={mark} onClick={() => setMark(!mark)} className={cx("min-h-9", mark && "text-fg")} title="Current mark reference, not historical marks"><span aria-hidden>{mark ? "●" : "○"}</span> Current mark</button></div>
      </div>
      <span className="sr-only" role="status">{hovered ? `Observation ${priceLabel(hovered.v)} at ${new Date(hovered.t * 1000).toLocaleString()}` : ""}</span>
    </section>
  );
}
