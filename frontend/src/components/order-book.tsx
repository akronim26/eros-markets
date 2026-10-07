"use client";

import { useMemo } from "react";
import type { Level } from "@/lib/reads";
import { depthBarWidth } from "@/lib/book-depth";
import { lotsToClaims, tickToPrice } from "@/lib/units";
import { cx } from "./ui";

export type BookPriceIntent = { tick: number; nonce: number };
export function OrderBook({ levels, bestBid, bestAsk, emptyReason, onPrice }: { levels: Level[]; bestBid: number; bestAsk: number; emptyReason: string; onPrice: (tick: number) => void }) {
  const { bids, asks, max } = useMemo(() => {
    const side = (buy: boolean) => {
      let total = 0n;
      return levels.filter(l => (buy ? l.bidLots : l.askLots) > 0n).sort((a, b) => buy ? b.tick - a.tick : a.tick - b.tick).slice(0, 6).map(l => {
        const lots = buy ? l.bidLots : l.askLots;
        total += lots;
        return { tick: l.tick, lots, total };
      });
    };
    const bids = side(true), asks = side(false);
    return { bids, asks, max: [...bids, ...asks].reduce((m, v) => m > v.total ? m : v.total, 0n) };
  }, [levels]);
  const rows = (items: typeof bids, buy: boolean) => <div className={cx("flex min-h-[144px] flex-col", buy ? "justify-start" : "justify-end")}>{(buy ? items : [...items].reverse()).map(row => <button key={row.tick} onClick={() => onPrice(row.tick)} aria-label={`Use ${buy ? "bid" : "ask"} price ${tickToPrice(row.tick)}`} className="relative grid min-h-6 grid-cols-[1fr_1fr_1.2fr] items-center gap-1 px-3 text-right text-xs hover:bg-fg/5 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-signal">
    <span className={cx("pointer-events-none absolute inset-y-0 right-0 opacity-[0.09]", buy ? "bg-bid" : "bg-ask")} style={{ width: `${depthBarWidth(row.total, max, 100)}%` }} aria-hidden />
    <span className={cx("relative text-left tnum", buy ? "text-bid" : "text-ask")}>{tickToPrice(row.tick)}</span><span className="relative tnum">{lotsToClaims(row.lots)}</span><span className="relative tnum text-fg-3">{lotsToClaims(row.total)}</span>
  </button>)}</div>;
  return <section aria-label="Order book" className="flex min-w-0 flex-col border-line-strong bg-panel/30">
    <div className="hair-b flex min-h-11 items-center justify-between px-3"><h2 className="label text-fg">Order book</h2><span className="text-2xs text-fg-4">Gross claims</span></div>
    <div className="grid grid-cols-[1fr_1fr_1.2fr] gap-1 px-3 pb-1 pt-3 text-right text-2xs text-fg-4"><span className="text-left">Price</span><span>Size</span><span>Total</span></div>
    {asks.length || bids.length ? <>{rows(asks, false)}<div className="my-2 flex items-center justify-between border-y border-line px-3 py-2 text-xs"><span className="text-fg-3">Spread</span><span className="tnum">{bestBid && bestAsk ? tickToPrice(bestAsk - bestBid) : "—"}</span></div>{rows(bids, true)}</> : <p className="flex min-h-[334px] items-center justify-center px-4 text-center text-xs text-fg-3">{emptyReason}</p>}
    <p className="mt-auto px-3 py-3 text-2xs text-fg-4">Select a price for your order. Resting size may include stale orders; fills are checked at execution.</p>
  </section>;
}
