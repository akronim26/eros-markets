"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Point } from "@/lib/reads";
import { priceBridges, priceSegments } from "@/lib/price-chart";
import { INDEX_CARRY_SECS } from "@/lib/index-carry";
import { cx } from "./ui";

const RANGES = [{ label: "1H", seconds: 3600 }, { label: "6H", seconds: 21600 }, { label: "1D", seconds: 86400 }, { label: "ALL", seconds: Infinity }] as const;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const timeLabel = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

type Props = {
  /** YES price history in 0..1; NO is drawn as 1 − YES. */
  yes: Point[];
  yesLabel: string;
  noLabel: string;
  /** Collateral volume over the stored span, already formatted. */
  volume?: string;
  emptyTitle: string;
  emptyReason: string;
  readError?: boolean;
  /** Trade-priced series: the last price stands until the next trade, so the lines run flat to now. */
  holdLast?: boolean;
};

/** Gridline step (in probability) giving four to six lines across the visible span. */
function gridStep(span: number) {
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25]) if (span / step <= 5) return step;
  return 0.25;
}

/** Two-outcome probability chart: YES (green) and NO = 1 − YES (red), labelled at the line ends. */
export function OutcomeChart(p: Props) {
  const id = useId().replace(/:/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(300);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [range, setRange] = useState(RANGES.length - 1);
  const [hoverTime, setHoverTime] = useState<number>();
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => { setWidth(entry.contentRect.width); setHeight(Math.max(240, Math.floor(entry.contentRect.height))); });
    if (ref.current) ro.observe(ref.current);
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => { ro.disconnect(); clearInterval(timer); };
  }, []);
  const model = useMemo(() => {
    const end = Math.max(now, p.yes.at(-1)?.t ?? 0);
    const start = RANGES[range].seconds === Infinity ? Math.min(p.yes[0]?.t ?? end - 3600, end - 60) : end - RANGES[range].seconds;
    let yes = p.yes.filter(v => v.t >= start && v.t <= end);
    if (p.holdLast) {
      const traded = p.yes.filter(v => v.valid !== false);
      const before = traded.filter(v => v.t < start).at(-1), latest = traded.filter(v => v.t <= end).at(-1);
      const held = [...(before ? [{ ...before, t: start }] : []), ...yes.filter(v => v.valid !== false), ...(latest ? [{ ...latest, t: end }] : [])];
      // Steps, not slopes: between two trades the price was the earlier one.
      yes = held.flatMap((pt, i) => i > 0 && held[i - 1].v !== pt.v ? [{ ...held[i - 1], t: pt.t }, pt] : [pt]);
    }
    const no = yes.map(v => ({ ...v, v: 1 - v.v }));
    const valid = yes.filter(v => v.valid !== false);
    const values = valid.flatMap(v => [v.v, 1 - v.v]);
    const min = values.length ? Math.min(...values) : 0.4, max = values.length ? Math.max(...values) : 0.6;
    const step = gridStep(Math.max(max - min, 0.2) * 1.2);
    const lo = Math.max(0, Math.floor((min - step / 2) / step) * step), hi = Math.min(1, Math.ceil((max + step / 2) / step) * step);
    const grid: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += step) grid.push(Math.round(v * 1000) / 1000);
    return { start, end, valid, lo, hi, grid, ...(p.holdLast
      ? { yesSegments: yes.length ? [yes] : [], noSegments: no.length ? [no] : [], yesBridges: [], noBridges: [] }
      : { yesSegments: priceSegments(yes), noSegments: priceSegments(no), yesBridges: priceBridges(yes), noBridges: priceBridges(no) }) };
  }, [p.yes, p.holdLast, range, now]);
  // Right gutter holds the end labels and the percent axis.
  const labelW = width < 480 ? 92 : 132, axisW = 44;
  const left = 8, right = Math.max(left + 1, width - labelW - axisW), top = 16, bottom = height - 28;
  const x = (t: number) => left + (t - model.start) / Math.max(1, model.end - model.start) * (right - left);
  const y = (v: number) => bottom - (v - model.lo) / Math.max(1e-9, model.hi - model.lo) * (bottom - top);
  const path = (segments: Point[][]) => segments.map(points => points.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(2)},${y(pt.v).toFixed(2)}`).join(" ")).join(" ");
  const last = model.valid.at(-1);
  const fresh = !!last && !p.readError && (p.holdLast || now - last.t <= INDEX_CARRY_SECS && p.yes.at(-1)?.valid !== false);
  const hovered = hoverTime === undefined ? undefined : model.valid.reduce<Point | undefined>((a, b) => !a || Math.abs(b.t - hoverTime) < Math.abs(a.t - hoverTime) ? b : a, undefined);
  const shown = hovered ?? last;
  const pointer = (clientX: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (bounds) setHoverTime(model.start + Math.max(0, Math.min(1, (clientX - bounds.left - left) / (right - left))) * (model.end - model.start));
  };
  // End labels sit beside each line's last point, pushed apart when the two lines are close.
  const big = width < 480 ? 22 : 30;
  const labels = shown ? (() => {
    // One label block is a 13px name over the big percentage.
    const gap = big + 24;
    let yy = y(shown.v), ny = y(1 - shown.v);
    if (Math.abs(yy - ny) < gap) {
      const mid = (yy + ny) / 2, up = shown.v >= 0.5 ? -1 : 1;
      yy = mid + up * gap / 2; ny = mid - up * gap / 2;
    }
    const clamp = (v: number) => Math.max(top + big * 0.62 + 12, Math.min(bottom - big * 0.42, v));
    return { yes: clamp(yy), no: clamp(ny) };
  })() : undefined;

  return (
    <section aria-label="Outcome price chart" className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-3">
        <div className="flex items-center gap-4 text-xs">
          <span className="tnum font-medium text-fg-2">{p.volume ?? "—"} Vol.</span>
          <span className="inline-flex items-center gap-1.5 text-fg-3"><span className="h-2 w-2 bg-yes" aria-hidden />{p.yesLabel}</span>
          <span className="inline-flex items-center gap-1.5 text-fg-3"><span className="h-2 w-2 bg-no" aria-hidden />{p.noLabel}</span>
        </div>
        <span className={cx("inline-flex items-center gap-1.5 text-2xs", fresh ? "text-yes" : "text-fg-3")}><span className={cx("h-1.5 w-1.5", fresh ? "bg-yes" : "bg-fg-4")} aria-hidden />{p.readError ? "Reconnecting" : fresh ? "Live" : last ? "Delayed" : "Connecting"}</span>
      </div>
      <div ref={ref} className="relative min-h-64 min-w-0 flex-1">
        {width > 0 && <svg width={width} height={height} role="img" tabIndex={0}
          aria-label={`${p.yesLabel} and ${p.noLabel} prices over time. Use left and right arrow keys to inspect; Escape to return to live.`}
          className="absolute inset-0 touch-pan-y outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-signal"
          onPointerMove={e => pointer(e.clientX)} onPointerDown={e => pointer(e.clientX)} onPointerLeave={() => setHoverTime(undefined)} onBlur={() => setHoverTime(undefined)}
          onKeyDown={e => {
            if (e.key === "Escape") { setHoverTime(undefined); return; }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || !model.valid.length) return;
            e.preventDefault();
            const current = hovered ? model.valid.indexOf(hovered) : model.valid.length - 1;
            const next = e.key === "Home" ? 0 : e.key === "End" ? model.valid.length - 1 : Math.max(0, Math.min(model.valid.length - 1, current + (e.key === "ArrowLeft" ? -1 : 1)));
            setHoverTime(model.valid[next].t);
          }}>
          <defs><clipPath id={`${id}-plot`}><rect x={left} y={top - 8} width={right - left + 8} height={bottom - top + 16} /></clipPath></defs>
          {model.grid.map(v => <g key={v}>
            <line x1={left} x2={width - axisW + 4} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeDasharray="1 5" strokeLinecap="round" />
            <text x={width - 6} y={y(v) + 4} textAnchor="end" fontSize={12} fill="var(--color-fg-3)" className="tnum">{pct(v)}</text>
          </g>)}
          {(width < 480 ? [1, 2] : [1, 2, 3]).map((i, _, a) => model.start + (model.end - model.start) * i / (a.length + 1)).map(t =>
            <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fontSize={12} fill="var(--color-fg-3)" className="tnum">
              {model.end - model.start > 86400 ? new Date(t * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : timeLabel(t)}</text>)}
          <g clipPath={`url(#${id}-plot)`}>
            {([["no", model.noSegments, model.noBridges], ["yes", model.yesSegments, model.yesBridges]] as const).map(([o, segments, bridges]) => <g key={o}>
              {bridges.length > 0 && <path d={path(bridges)} fill="none" stroke={`var(--color-${o})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
                <title>No valid price: the Kuru book was too thin. Not a tradable price.</title></path>}
              <path d={path(segments)} fill="none" stroke={`var(--color-${o})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>)}
            {hovered && <line x1={x(hovered.t)} x2={x(hovered.t)} y1={top} y2={bottom} stroke="var(--color-fg-4)" strokeDasharray="3 3" />}
            {shown && ([["no", 1 - shown.v], ["yes", shown.v]] as const).map(([o, v]) => <g key={o}>
              {!hovered && fresh && <circle cx={x(shown.t)} cy={y(v)} r={8} fill={`var(--color-${o})`} opacity={0.18} className="motion-safe:animate-pulse" />}
              <circle cx={x(shown.t)} cy={y(v)} r={4} fill={`var(--color-${o})`} stroke="var(--color-ground)" strokeWidth={hovered ? 2 : 0} />
            </g>)}
          </g>
          {shown && labels && ([["yes", p.yesLabel, shown.v, labels.yes], ["no", p.noLabel, 1 - shown.v, labels.no]] as const).map(([o, name, v, ly]) =>
            <g key={o} className="tnum">
              <text x={Math.min(x(shown.t), right) + 12} y={ly - big * 0.62} fontSize={13} fontWeight={500} fill={`var(--color-${o})`}>{name}</text>
              <text x={Math.min(x(shown.t), right) + 12} y={ly + big * 0.42} fontSize={big} fontWeight={700} fill={`var(--color-${o})`}>{pct(v)}</text>
            </g>)}
        </svg>}
        {!last && <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6"><div className="max-w-xs bg-ground/90 px-4 py-3 text-center"><p className="text-sm font-medium">{p.emptyTitle}</p><p className="mt-1 text-xs text-fg-3">{p.emptyReason}</p></div></div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 px-4 pb-2 text-2xs text-fg-3">
        <span>{hovered ? new Date(hovered.t * 1000).toLocaleString() : last ? `${p.holdLast ? "Last trade" : "Updated"} ${new Date((p.yes.filter(v => v.valid !== false).at(-1)?.t ?? last.t) * 1000).toLocaleTimeString()}` : "No prices yet"}</span>
        <div role="group" aria-label="Chart time range" className="flex gap-1">{RANGES.map((r, i) => <button key={r.label} aria-pressed={range === i} onClick={() => { setRange(i); setHoverTime(undefined); }}
          className={cx("tnum min-h-9 min-w-9 px-2 text-xs font-semibold transition-colors", range === i ? "bg-press text-fg" : "text-fg-3 hover:text-fg")}>{r.label}</button>)}</div>
      </div>
      <span className="sr-only" role="status">{hovered ? `${p.yesLabel} ${pct(hovered.v)}, ${p.noLabel} ${pct(1 - hovered.v)} at ${new Date(hovered.t * 1000).toLocaleString()}` : ""}</span>
    </section>
  );
}
