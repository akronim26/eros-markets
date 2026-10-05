"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useHead, useLadder, useLiveSeries, useMarket, useTrader } from "@/lib/reads";
import type { MarketManifest } from "@/config/deployment";
import { wadToUnit } from "@/lib/units";
import { PriceAxis } from "./price-axis";
import { Ticket } from "./ticket";
import { AccountPanel, DeadlineStrip, MarketHeader, MarketInfo, PositionPanel } from "./market-parts";
import { useOwner } from "./wallet";
import { cx } from "./ui";
import styles from "./terminal.module.css";

const TABS = ["Position", "Market info", "Open orders"] as const;

export function Terminal({ manifest }: { manifest: MarketManifest }) {
  const head = useHead();
  const block = head.data?.number;
  const m = useMarket(manifest.engine, block);
  const owner = useOwner();
  const t = useTrader(manifest.engine, owner.address, block);
  const ladder = useLadder(manifest.engine, block, m.data?.bestBid ?? 0, m.data?.bestAsk ?? 0);
  const live = useLiveSeries(manifest.engine, block);
  const [picked, setTab] = useState<(typeof TABS)[number] | null>(null);
  const tab = picked ?? (owner.connected ? "Position" : "Market info");

  const md = m.data;
  const emptyReason = !md
    ? "Reading the market from Monad testnet…"
    : !md.active
      ? "This market is not active yet. The index, book price and trades will appear here as they become available."
      : md.risk.indexAvailable
        ? "Index is live; price history accumulates here while this page is open. Full history arrives with the indexer."
        : "Waiting for a fresh signed index window (300 seconds of valid observations).";

  return (
    <main className={cx(styles.terminal, "frame mx-3 mb-3 grid grid-cols-1 bg-ground max-md:mx-2 lg:grid-cols-[minmax(0,1fr)_300px]")}>
      <div className="hair-b col-span-full flex items-center gap-4 bg-panel px-3 py-2">
        <Link href="/markets" aria-label="Back to all markets" className="label group inline-flex min-h-11 shrink-0 items-center gap-2 bg-signal px-4 font-semibold text-on-signal transition-colors hover:bg-signal/85">
          <ArrowLeft size={15} strokeWidth={2} className="transition-transform duration-150 group-hover:-translate-x-0.5" aria-hidden />
          All markets
        </Link>
        <span className="label text-fg-3">Trading terminal</span>
      </div>
      <div className={cx(styles.content, "flex min-w-0 flex-col")}>
        <MarketHeader manifest={manifest} m={md} />
        <div className="label hair-b flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-1.5 text-fg-3">
          <span className="flex items-center gap-1.5"><span className={cx("h-[2px] w-4", md?.risk.indexAvailable ? "bg-fg" : "bg-fg-4 [mask:repeating-linear-gradient(90deg,#000_0_2px,transparent_2px_4px)]")} aria-hidden />Index</span>
          <span className="flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-ivory-3" aria-hidden />Book price</span>
          <span className="flex items-center gap-1.5"><span className={cx("h-[5px] w-4", md?.risk.markAvailable ? "bg-signal" : "shadow-[inset_0_0_0_1px_var(--color-signal)]")} aria-hidden />Mark</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 bg-bid" aria-hidden />Bids</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 bg-ask" aria-hidden />Asks</span>
          <span className="ml-auto tnum max-md:hidden">
            {live.since !== undefined ? `Live since block ${live.since.toString()}` : "Connecting…"}
            {live.error ? " · log read failed, retrying" : ""}
          </span>
        </div>
        <div className="h-[280px] shrink-0 md:h-[300px]">
          <PriceAxis
            index={live.index}
            perp={live.perp}
            trades={live.trades}
            levels={ladder.data ?? []}
            markUnit={md?.risk.markAvailable ? wadToUnit(md.risk.markWad) : undefined}
            bestBid={md?.bestBid ?? 0}
            bestAsk={md?.bestAsk ?? 0}
            emptyTitle={md && !md.active ? "No price yet" : "Waiting for price"}
            emptyReason={emptyReason}
            ladderEmptyReason="Book empty: no resting orders"
          />
        </div>
        <DeadlineStrip m={md} now={head.data?.timestamp} />
        <div className="flex flex-col lg:hidden">
          <div className="hair-b">
            <Ticket engine={manifest.engine} market={md} trader={t.data} />
          </div>
          <AccountPanel engine={manifest.engine} m={md} t={t.data} />
        </div>
        <div className="flex flex-col">
          <div className="hair-b flex h-9 items-stretch px-2" role="tablist" aria-label="Details">
            {TABS.map((x) => (
              <button
                key={x}
                role="tab"
                aria-selected={tab === x}
                onClick={() => setTab(x)}
                className={cx("label relative px-2 sm:px-3", tab === x ? "text-fg" : "text-fg-3 hover:text-fg")}
              >
                {x}
                {tab === x && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-signal" aria-hidden />}
              </button>
            ))}
          </div>
          {tab === "Position" ? (
            <PositionPanel m={md} t={t.data} />
          ) : tab === "Market info" ? (
            <MarketInfo manifest={manifest} m={md} />
          ) : (
            <p className="max-w-xl px-4 py-4 text-sm leading-relaxed text-fg-3">
              {owner.connected
                ? "You have no resting orders on this market. Orders you place appear here with their fill state; order history arrives with the indexer."
                : "Log in to see your resting orders."}
            </p>
          )}
        </div>
      </div>

      <aside className="hidden flex-col border-l border-line-strong lg:flex" aria-label="Trade">
        <div className="hair-b">
          <Ticket engine={manifest.engine} market={md} trader={t.data} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <AccountPanel engine={manifest.engine} m={md} t={t.data} />
        </div>
      </aside>
    </main>
  );
}
