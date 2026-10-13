"use client";

import { useMemo } from "react";
import type { Trade } from "@/lib/reads";
import { lotsToClaims, tickToPrice } from "@/lib/units";
import { explorerTx } from "@/config/chain";
import { cx } from "./ui";

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Public fills, newest first. Fills carry no aggressor side, so colour follows the tick: up green, down orange. */
export function MarketTrades({ trades, status, limit = 40 }: { trades: Trade[]; status: string; limit?: number }) {
  const rows = useMemo(() => {
    const ordered = [...trades].sort((a, b) => Number(b.block - a.block) || b.t - a.t).slice(0, limit + 1);
    return ordered.slice(0, limit).map((trade, i) => {
      const before = ordered[i + 1];
      return { ...trade, move: !before ? 0 : Math.sign(trade.tick - before.tick) };
    });
  }, [trades, limit]);

  return <section aria-label="Market trades" className="flex h-full min-h-0 min-w-0 flex-col">
    <div className="flex min-h-9 items-center justify-between border-b border-line px-3">
      <h2 className="relative text-xs font-medium">Market trades</h2>
      <span className="text-2xs text-fg-4" title="Trade prices are YES-denominated">YES</span>
    </div>
    <div className="grid grid-cols-[1fr_1fr_1fr] gap-1 px-3 py-2 text-2xs text-fg-4"><span>Price</span><span className="text-right">Claims</span><span className="text-right">Time</span></div>
    {rows.length ? <ol className="min-h-0 flex-1 overflow-y-auto pb-2">
      {rows.map((trade, i) => <li key={`${trade.tx}-${trade.block}-${i}`}>
        <a href={explorerTx(trade.tx)} target="_blank" rel="noreferrer" title="View transaction"
          className="grid min-h-6 grid-cols-[1fr_1fr_1fr] items-center gap-1 px-3 text-xs hover:bg-fg/5">
          <span className={cx("tnum", trade.move > 0 ? "text-bid" : trade.move < 0 ? "text-ask" : "text-fg")}>{tickToPrice(trade.tick)}</span>
          <span className="tnum text-right">{lotsToClaims(trade.size)}</span>
          <span className="tnum text-right text-fg-3">{trade.t ? time.format(new Date(trade.t * 1000)) : "—"}</span>
        </a>
      </li>)}
    </ol> : <p className="flex min-h-40 flex-1 items-center justify-center px-4 text-center text-xs text-fg-3">{status}</p>}
  </section>;
}
