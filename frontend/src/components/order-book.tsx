"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Level } from "@/lib/reads";
import { depthBarWidth } from "@/lib/book-depth";
import { lotsToClaims, tickToPrice } from "@/lib/units";
import { cx } from "./ui";

export type BookPriceIntent = { tick: number; nonce: number };
type View = "both" | "bids" | "asks";
const VIEWS: { value: View; label: string }[] = [{ value: "both", label: "Bids and asks" }, { value: "bids", label: "Bids only" }, { value: "asks", label: "Asks only" }];

/** Three stacked bars: the view it selects is drawn in the side colours. */
function ViewIcon({ view }: { view: View }) {
  const top = view === "bids" ? "bg-bid" : "bg-ask", bottom = view === "asks" ? "bg-ask" : "bg-bid";
  return <span className="grid h-3.5 w-3.5 grid-rows-2 gap-[2px]" aria-hidden><span className={cx("rounded-[1px]", top)} /><span className={cx("rounded-[1px]", bottom)} /></span>;
}

export function OrderBook({ levels, bestBid, bestAsk, last, emptyReason, onPrice }: {
  levels: Level[]; bestBid: number; bestAsk: number;
  /** Latest trade (or the mark when no trade is known) and its move against the previous trade. */
  last?: { tick: number; move: number; label: string };
  emptyReason: string; onPrice: (tick: number) => void;
}) {
  const [view, setView] = useState<View>("both");
  const depth = view === "both" ? 10 : 20;
  const { bids, asks, max, bidTotal, askTotal } = useMemo(() => {
    const side = (buy: boolean) => {
      let total = 0n;
      return levels.filter(l => (buy ? l.bidLots : l.askLots) > 0n).sort((a, b) => buy ? b.tick - a.tick : a.tick - b.tick).slice(0, depth).map(l => {
        const lots = buy ? l.bidLots : l.askLots;
        total += lots;
        return { tick: l.tick, lots, total };
      });
    };
    const bids = side(true), asks = side(false);
    return { bids, asks, max: [...bids, ...asks].reduce((m, v) => m > v.total ? m : v.total, 0n),
      bidTotal: bids.at(-1)?.total ?? 0n, askTotal: asks.at(-1)?.total ?? 0n };
  }, [levels, depth]);
  const both = bidTotal + askTotal;
  const bidShare = both ? Number((bidTotal * 10_000n) / both) / 100 : 0;

  const rows = (items: typeof bids, buy: boolean) => <div className={cx("flex min-h-0 flex-1 flex-col overflow-hidden", buy ? "justify-start" : "justify-end")}>{(buy ? items : [...items].reverse()).map(row => <button key={row.tick} onClick={() => onPrice(row.tick)} aria-label={`Use ${buy ? "bid" : "ask"} price ${tickToPrice(row.tick)}`} className="relative grid min-h-6 shrink-0 grid-cols-[1fr_1fr_1.2fr] items-center gap-1 rounded-none px-3 text-right text-xs hover:bg-fg/5 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-signal">
    <span className={cx("pointer-events-none absolute inset-y-px right-0 opacity-[0.12]", buy ? "bg-bid" : "bg-ask")} style={{ width: `${depthBarWidth(row.total, max, 100)}%` }} aria-hidden />
    <span className={cx("relative text-left tnum", buy ? "text-bid" : "text-ask")}>{tickToPrice(row.tick)}</span><span className="relative tnum">{lotsToClaims(row.lots)}</span><span className="relative tnum text-fg-3">{lotsToClaims(row.total)}</span>
  </button>)}</div>;

  const hasLevels = asks.length || bids.length;
  return <section aria-label="Order book" className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="flex min-h-9 items-center justify-between border-b border-line px-3"><h2 className="text-xs font-medium">Order book</h2><span className="text-2xs text-fg-3" title="YES-denominated prices; NO prices are their complement">YES</span></div>
    <div className="flex items-center gap-1 px-2 pt-2" role="group" aria-label="Order book view">
      {VIEWS.map(v => <button key={v.value} type="button" aria-pressed={view === v.value} aria-label={v.label} title={v.label}
        onClick={() => setView(v.value)} className={cx("grid h-7 w-7 place-items-center rounded-md", view === v.value ? "bg-press" : "opacity-60 hover:bg-hover hover:opacity-100")}>
        <ViewIcon view={v.value} />
      </button>)}
    </div>
    <div className="grid grid-cols-[1fr_1fr_1.2fr] gap-1 px-3 py-2 text-right text-2xs text-fg-4"><span className="text-left">Price</span><span>Claims</span><span>Total</span></div>
    {hasLevels ? <>
      {view !== "bids" && rows(asks, false)}
      <div className="flex items-center justify-between gap-2 border-y border-line px-3 py-2">
        {last ? <span className={cx("inline-flex items-center gap-1 text-lg font-semibold tnum", last.move > 0 ? "text-bid" : last.move < 0 ? "text-ask" : "text-fg")} title={last.label}>
          {tickToPrice(last.tick)}{last.move > 0 ? <ArrowUp size={15} aria-hidden /> : last.move < 0 ? <ArrowDown size={15} aria-hidden /> : null}
          <span className="sr-only">{last.label}</span>
        </span> : <span className="text-xs text-fg-3">No trades yet</span>}
        <span className="text-2xs text-fg-3">Spread <span className="tnum text-fg">{bestBid && bestAsk ? tickToPrice(bestAsk - bestBid) : "—"}</span></span>
      </div>
      {view !== "asks" && rows(bids, true)}
    </> : <p className="flex min-h-72 flex-1 items-center justify-center px-4 text-center text-xs text-fg-3">{emptyReason}</p>}
    {both > 0n && <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-2xs tnum" title="Share of displayed resting depth on each side">
      <span className="text-bid">B {bidShare.toFixed(1)}%</span>
      <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-ask/80" aria-hidden><span className="h-full rounded-full bg-bid" style={{ width: `${bidShare}%` }} /></span>
      <span className="text-ask">{(100 - bidShare).toFixed(1)}% S</span>
    </div>}
    <p className="border-t border-line px-3 py-2 text-2xs text-fg-4" title="Displayed resting orders may be stale. Executable quantities are checked when the order trades.">Select a price to trade</p>
  </section>;
}
