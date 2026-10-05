"use client";

import { useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { useHead, useLadder, useLiveSeries, useMarket, useTrader } from "@/lib/reads";
import { markets, type MarketManifest } from "@/config/deployment";
import { wadTo3, wadToUnit } from "@/lib/units";
import { PriceAxis } from "./price-axis";
import { Ticket } from "./ticket";
import { AccountPanel, DeadlineStrip, MarketHeader, MarketInfo, PositionPanel, chipFor } from "./market-parts";
import { useOwner } from "./wallet";
import { Chip, RegionHead, cx } from "./ui";

function MarketRail({ current }: { current: Address }) {
  const head = useHead();
  return (
    <nav aria-label="Markets" className="flex h-full flex-col bg-panel">
      <RegionHead title="Markets">{markets.length}</RegionHead>
      <ul>
        {markets.map((mk) => (
          <RailItem key={mk.engine} mk={mk} active={mk.engine.toLowerCase() === current.toLowerCase()} block={head.data?.number} />
        ))}
      </ul>
      <p className="mt-auto p-3 text-2xs leading-relaxed text-fg-3">
        More markets appear here as they are listed through the market registry.
      </p>
    </nav>
  );
}

function RailItem({ mk, active, block }: { mk: MarketManifest; active: boolean; block?: bigint }) {
  const m = useMarket(mk.engine, block);
  const chip = m.data ? chipFor(m.data) : null;
  return (
    <li>
      <Link
        href={`/m/${mk.engine}`}
        aria-current={active ? "page" : undefined}
        className={cx("hair-b relative flex flex-col gap-1.5 px-3 py-2.5", active ? "bg-press" : "hover:bg-hover")}
      >
        {active && <span className="absolute inset-y-0 left-0 w-px bg-fg" aria-hidden />}
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-fg">{mk.short}</span>
          <span className="tnum text-sm text-fg-2">{m.data?.risk.markAvailable ? wadTo3(m.data.risk.markWad) : "—"}</span>
        </span>
        <span className="line-clamp-2 text-2xs leading-snug text-fg-3">{mk.title}</span>
        {chip && <Chip tone={chip.tone} className="self-start">{chip.label}</Chip>}
      </Link>
    </li>
  );
}

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
      ? "This market has not been activated, and no signed index observations have been published. The index, the book-derived price and trades will draw here on one probability axis as soon as they exist."
      : md.risk.indexAvailable
        ? "Index is live; price history accumulates here while this page is open. Full history arrives with the indexer."
        : "Waiting for a fresh signed index window (300 seconds of valid observations).";

  return (
    <main className="frame mx-3 mb-3 grid min-h-[calc(100dvh-120px)] grid-cols-1 bg-ground max-md:mx-2 lg:grid-cols-[232px_minmax(0,1fr)_300px]">
      <div className="hidden border-r border-line-strong lg:block">
        <MarketRail current={manifest.engine} />
      </div>

      <div className="flex min-w-0 flex-col">
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
        <div className="h-[46vh] min-h-[300px] lg:h-auto lg:flex-1">
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
                className={cx("label relative px-3", tab === x ? "text-fg" : "text-fg-3 hover:text-fg")}
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
