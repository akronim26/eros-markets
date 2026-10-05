"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Level, Point, Trade } from "@/lib/reads";
import { cx } from "./ui";

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

type Props = {
  index: Point[];
  perp: Point[];
  trades: Trade[];
  levels: Level[];
  markUnit?: number; // mark as a number in [0,1] for geometry only; undefined = unavailable
  bestBid: number;
  bestAsk: number;
  emptyTitle: string;
  emptyReason: string;
  ladderEmptyReason: string;
};

const AXIS_W = 56;
const PAD_TOP = 30; // reserves the axis slot where an unavailable mark is stated
const PAD_Y = 14;

/**
 * Signature move: chart and order book share one probability axis. A book level sits at the same
 * height as that price on the chart; the Signal bar marks the mark price across both.
 */
export function PriceAxis(p: Props) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const LADDER_W = w < 640 ? Math.round(w * 0.24) : 196;
  const chartW = Math.max(0, w - LADDER_W - AXIS_W);
  const narrow = w > 0 && w < 640;

  const range = useMemo(() => {
    const vals = [
      ...p.index.map((x) => x.v),
      ...p.perp.map((x) => x.v),
      ...p.trades.map((x) => x.tick / 1000),
      ...p.levels.filter((l) => l.bidLots > 0n || l.askLots > 0n).map((l) => l.tick / 1000),
      ...(p.markUnit !== undefined ? [p.markUnit] : []),
    ];
    if (vals.length === 0) return { lo: 0, hi: 1, step: 0.1 };
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const span = Math.max(hi - lo, 0.04);
    lo = Math.max(0, lo - span * 0.35);
    hi = Math.min(1, hi + span * 0.35);
    const step = hi - lo > 0.3 ? 0.05 : hi - lo > 0.12 ? 0.02 : 0.01;
    return { lo, hi, step };
  }, [p.index, p.perp, p.trades, p.levels, p.markUnit]);

  const y = (v: number) => PAD_TOP + (1 - (v - range.lo) / (range.hi - range.lo)) * (h - PAD_TOP - PAD_Y);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let v = Math.ceil(range.lo / range.step) * range.step; v <= range.hi + 1e-9; v += range.step) out.push(+v.toFixed(3));
    return out;
  }, [range]);

  const series = useMemo(() => {
    const pts = [...p.index, ...p.perp, ...p.trades];
    if (pts.length === 0) return null;
    const t0 = Math.min(...pts.map((x) => x.t));
    const t1 = Math.max(...pts.map((x) => x.t), t0 + 1);
    const x = (t: number) => ((t - t0) / (t1 - t0)) * (chartW - 12) + 6;
    const path = (s: Point[]) => s.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.v).toFixed(1)}`).join("");
    return { index: path(p.index), perp: path(p.perp), x };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.index, p.perp, p.trades, chartW, h, range]);

  const maxLots = useMemo(
    () => p.levels.reduce((m, l) => (l.bidLots > m ? l.bidLots : l.askLots > m ? l.askLots : m), 0n),
    [p.levels],
  );
  const rowH = Math.max(2, Math.min(12, ((h - PAD_TOP - PAD_Y) / ((range.hi - range.lo) * 1000)) * 0.8));
  const hasSeries = !!series && (p.index.length > 1 || p.perp.length > 1 || p.trades.length > 0);
  const hasBook = maxLots > 0n;
  const compactEmpty = w > 0 && w < 480 && !hasBook;

  return (
    <div ref={ref} className="relative h-full min-h-[280px] w-full select-none">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} className="absolute inset-0" role="img" aria-label="Price chart and order book on one probability axis">
          {/* hairline grid, shared by chart and ladder */}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={0} x2={chartW + LADDER_W} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} stroke="var(--color-line)" />
              <text x={w - 8} y={y(v) + 4} textAnchor="end" className="tnum" fontSize={12} fill="var(--color-fg-4)">
                {v.toFixed(range.step < 0.02 ? 3 : 2)}
              </text>
            </g>
          ))}
          {/* chart / ladder seam */}
          <line x1={chartW + 0.5} x2={chartW + 0.5} y1={0} y2={h} stroke="var(--color-line-strong)" />
          <line x1={chartW + LADDER_W + 0.5} x2={chartW + LADDER_W + 0.5} y1={0} y2={h} stroke="var(--color-line)" />

          {hasSeries && (
            <>
              <path d={series!.perp} fill="none" stroke="var(--color-fg-3)" strokeWidth={1} strokeDasharray="3 3" />
              <path d={series!.index} fill="none" stroke="var(--color-fg)" strokeWidth={1.5} />
              {p.trades.map((trade, i) => <circle key={`${trade.tx}-${i}`} cx={series!.x(trade.t)} cy={y(trade.tick / 1000)} r={2.5} fill="var(--color-signal)"><title>Trade at {(trade.tick / 1000).toFixed(3)}</title></circle>)}
            </>
          )}

          {/* depth ladder: flat bars growing from the seam, bids below, asks above */}
          {p.levels.map((l) => {
            const lots = l.bidLots > 0n ? l.bidLots : l.askLots;
            if (lots === 0n || maxLots === 0n) return null;
            const width = Math.max(2, Number((lots * 1000n) / maxLots) / 1000) * (LADDER_W - 8);
            return (
              <rect
                key={l.tick}
                x={chartW + 1}
                y={y(l.tick / 1000) - rowH / 2}
                width={Math.min(width, LADDER_W - 8)}
                height={rowH}
                fill={l.bidLots > 0n ? "var(--color-bid)" : "var(--color-ask)"}
                opacity={0.85}
              />
            );
          })}

          {/* empty book stated as zero: hollow rows at the seam, one per price level of the grid */}
          {!hasBook &&
            ticks.map((v) => (
              <rect key={`z${v}`} x={chartW + 6.5} y={Math.round(y(v)) - 3.5} width={6} height={6} fill="none" stroke="var(--color-line-strong)" />
            ))}

          {/* unavailable mark stated as a mark: an outlined Signal tag in the reserved axis slot */}
          {p.markUnit === undefined && (
            <g>
              <rect x={chartW + LADDER_W + 4.5} y={6.5} width={AXIS_W - 9} height={17} fill="none" stroke="var(--color-signal)" />
              <text x={chartW + LADDER_W + AXIS_W / 2} y={19} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--color-signal)">
                —
              </text>
            </g>
          )}

          {/* the Signal bar: mark price across chart and book, as in the mark */}
          {p.markUnit !== undefined && (
            <g>
              <rect x={0} y={y(p.markUnit) - 1.5} width={chartW + LADDER_W} height={3} fill="var(--color-signal)" />
              <rect x={chartW + LADDER_W} y={y(p.markUnit) - 9} width={AXIS_W} height={18} fill="var(--color-signal)" />
              <text x={w - 6} y={y(p.markUnit) + 4} textAnchor="end" fontSize={12} fontWeight={600} className="tnum" fill="var(--color-on-signal)">
                {p.markUnit.toFixed(3)}
              </text>
            </g>
          )}
        </svg>
      )}

      {!hasSeries && (
        <div
          className={cx("pointer-events-none absolute inset-y-0 left-0 flex items-center justify-center px-3 sm:px-5", compactEmpty && "pb-12")}
          style={{ width: compactEmpty ? w - AXIS_W : chartW || "60%" }}
        >
          <div className="frame max-w-sm bg-ground">
            {!compactEmpty && <p className="label px-3 py-2 text-fg-3 shadow-[inset_0_-1px_0_var(--color-line-strong)]">STATE.PRICE</p>}
            <div className="p-4">
              <p className="text-lg font-medium text-fg">{p.emptyTitle}</p>
              <p className="mt-2 text-sm leading-relaxed text-fg-3">{p.emptyReason}</p>
            </div>
          </div>
        </div>
      )}
      {!hasBook && w > 0 && (
        <div
          className={cx("absolute bottom-0 bg-ground px-3 py-1.5 text-2xs text-fg-3", narrow && "px-1.5")}
          style={{ left: chartW + 1, width: LADDER_W - 1 }}
        >
          {narrow ? "Book empty" : p.ladderEmptyReason}
        </div>
      )}
    </div>
  );
}
