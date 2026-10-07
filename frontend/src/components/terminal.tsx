"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useHead, useLadder, useMarket, useTrader } from "@/lib/reads";
import { usePriceSeries } from "@/lib/price-history";
import type { MarketManifest } from "@/config/deployment";
import { wadToUnit } from "@/lib/units";
import { PriceAxis } from "./price-axis";
import { OrderBook, type BookPriceIntent } from "./order-book";
import { closeIntent, type CloseIntent } from "@/lib/trade-intent";
import { PageLoading } from "./feedback";
import { Ticket } from "./ticket";
import { AccountPanel, DeadlineStrip, MarketHeader, MarketInfo, PositionPanel } from "./market-parts";
import { useOwner } from "./wallet";
import { cx, selectionKeys } from "./ui";
import styles from "./terminal.module.css";
import { OpenOrders } from "./open-orders";
import { ProtectionPanel } from "./protection-panel";
import { RiskPanel } from "./risk-panel";
import { ReservePanel } from "./reserve-panel";
import { OperationsPanel } from "./operations-panel";
import { OracleMarket } from "./resolution";
import { AccountHistory } from "./account-history";

const TABS = ["Position", "Market info", "Open orders", "History", "Protection", "Risk", "Liquidity", "Operations", "Resolution"] as const;

export function Terminal({ manifest }: { manifest: MarketManifest }) {
  const tabsId = useId();
  const head = useHead();
  const block = head.data?.number;
  const m = useMarket(manifest.engine, block);
  const owner = useOwner();
  const t = useTrader(manifest.engine, owner.address, block);
  const ladder = useLadder(manifest.engine, block, m.data?.bestBid ?? 0, m.data?.bestAsk ?? 0);
  const live = usePriceSeries(manifest.engine, block);
  const [intent, setIntent] = useState<CloseIntent>();
  const [bookPrice, setBookPrice] = useState<BookPriceIntent>();
  useEffect(() => setIntent(undefined), [owner.address]);
  const [picked, setTab] = useState<(typeof TABS)[number] | null>(null);
  const tab = picked ?? (owner.connected ? "Position" : "Market info");

  const md = m.data;
  const emptyReason = manifest.archived
    ? "This demo has been archived. Live price services have stopped; historical observations may still appear."
    : !md
    ? "Reading the market from Monad testnet…"
    : !md.active
      ? "This market is not active yet. The index, book price and trades will appear here as they become available."
      : md.risk.indexAvailable
        ? "Index is live. Price observations will appear here as they arrive."
        : "Waiting for a fresh signed index window (300 seconds of valid observations).";

  if (!md && !m.isError && !head.isError) return <PageLoading title="Opening the terminal" />;

  return (
    <main className={cx(styles.terminal, "frame mx-3 mb-3 grid grid-cols-1 bg-ground max-md:mx-2 lg:grid-cols-[minmax(0,1fr)_300px]")}>
      <div className="hair-b col-span-full flex items-center gap-4 bg-panel px-3 py-2">
        <Link href="/markets" aria-label="Back to all markets" className="label group inline-flex min-h-11 shrink-0 items-center gap-2 bg-signal px-4 font-semibold text-on-signal transition-colors hover:bg-signal/85">
          <ArrowLeft size={15} strokeWidth={2} className="transition-transform duration-150 group-hover:-translate-x-0.5" aria-hidden />
          All markets
        </Link>
        <span className="label text-fg-3">Trading terminal</span>
      </div>
      {manifest.archived && <p role="status" className="hair-b col-span-full bg-panel px-4 py-3 text-sm text-fg-2"><strong className="text-fg">Archived demo.</strong> New positions are disabled here. Existing orders, position reductions and collateral controls remain available, subject to contract checks. Live price services have stopped.</p>}
      <div className={cx(styles.content, "flex min-w-0 flex-col")}>
        <MarketHeader manifest={manifest} m={md} />
        {(m.isError || t.isError || head.isError || ladder.isError) && <p role="alert" className="hair-b px-4 py-2 text-xs text-signal-text">Live reads failed. Any displayed snapshot retains its original block; transactions are checked again before signing. <button className="underline" onClick={() => { void head.refetch(); void m.refetch(); void ladder.refetch(); if (owner.address) void t.refetch(); }}>Retry</button></p>}
        <div className={cx(styles.priceWorkspace, "hair-b grid min-w-0")}>
          <PriceAxis
            index={live.index}
            perp={live.perp}
            markUnit={md?.risk.markAvailable ? wadToUnit(md.risk.markWad) : undefined}
            indexUnit={md?.risk.indexAvailable ? wadToUnit(md.risk.indexWad) : undefined}
            emptyTitle={manifest.archived ? "Market archived" : md && !md.active ? "No price yet" : "Waiting for price"}
            emptyReason={emptyReason}
            historyStatus={live.historyStatus}
            readError={!!live.error || m.isError || head.isError}
          />
          <OrderBook levels={ladder.isError ? [] : ladder.data ?? []} bestBid={md?.bestBid ?? 0} bestAsk={md?.bestAsk ?? 0}
            emptyReason={ladder.isError || m.isError || head.isError ? "Book unavailable" : !md || (!ladder.data && !!(md.bestBid || md.bestAsk)) ? "Loading book…" : "Book empty"}
            onPrice={tick => setBookPrice({ tick, nonce: Date.now() })} />
        </div>
        <div className="flex flex-col lg:hidden">
          <div className="hair-b">
            <Ticket key={owner.address ?? "disconnected"} engine={manifest.engine} market={md} trader={t.data} intent={intent} bookPrice={bookPrice} readUnavailable={head.isError || m.isError || t.isError} />
          </div>
          <AccountPanel engine={manifest.engine} m={md} t={t.data} readUnavailable={head.isError || m.isError || t.isError} />
        </div>
        <div className="flex flex-col">
          <div className="hair-b flex min-h-9 flex-wrap items-stretch px-2" role="tablist" aria-label="Details" onKeyDown={selectionKeys}>
            {TABS.map((x) => (
              <button
                key={x}
                role="tab"
                id={`${tabsId}-${TABS.indexOf(x)}`}
                aria-controls={`${tabsId}-panel`}
                tabIndex={tab === x ? 0 : -1}
                aria-selected={tab === x}
                onClick={() => setTab(x)}
                className={cx("label relative min-h-9 px-2 sm:px-3", tab === x ? "text-fg" : "text-fg-3 hover:text-fg")}
              >
                {x}
                {tab === x && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-signal" aria-hidden />}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${TABS.indexOf(tab)}`} tabIndex={0}>
          {tab === "Position" ? (
            <PositionPanel m={md} t={t.data} onReduce={(bps) => { if (md && t.data?.account?.preview.positionLots) { setIntent(closeIntent(t.data.account.preview.positionLots, md.bestBid, md.bestAsk, bps)); document.querySelector<HTMLElement>(window.innerWidth >= 1024 ? 'aside[aria-label="Trade"]' : 'section[aria-label="Order ticket"]')?.scrollIntoView({ behavior: "smooth", block: "center" }); } }} />
          ) : tab === "Market info" ? (
            <><DeadlineStrip m={md} now={head.data?.timestamp} /><MarketInfo manifest={manifest} m={md} /></>
          ) : tab === "Open orders" ? (
            <OpenOrders engine={manifest.engine} traderId={t.data?.traderId} block={block} />
          ) : tab === "Protection" ? (
            md ? <ProtectionPanel key={owner.address ?? "disconnected"} engine={manifest.engine} m={md} t={t.data} readUnavailable={head.isError || m.isError || t.isError} /> : <p className="p-4">Reading market…</p>
          ) : tab === "Risk" ? (
            md ? <RiskPanel key={owner.address ?? "disconnected"} m={md} t={t.data} /> : <p className="p-4">Reading market risk…</p>
          ) : tab === "Liquidity" ? (
            md ? <ReservePanel engine={manifest.engine} m={md} t={t.data} /> : <p className="p-4">Reading reserve…</p>
          ) : tab === "Operations" ? (
            md ? <OperationsPanel engine={manifest.engine} m={md} /> : <p className="p-4">Reading market…</p>
          ) : tab === "Resolution" ? (
            manifest.oracleMarketId ? <OracleMarket id={manifest.oracleMarketId} /> : <p className="p-4 text-sm text-fg-3">This fixture resolves through its manual test authority. It has no oracle proposal or dispute flow.</p>
          ) : (
            <AccountHistory engine={manifest.engine} traderId={t.data?.traderId} block={block} />
          )}
          </div>
        </div>
      </div>

      <aside className="hidden flex-col border-l border-line-strong lg:flex" aria-label="Trade">
        <div className="hair-b">
          <Ticket key={owner.address ?? "disconnected"} engine={manifest.engine} market={md} trader={t.data} intent={intent} bookPrice={bookPrice} readUnavailable={head.isError || m.isError || t.isError} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <AccountPanel engine={manifest.engine} m={md} t={t.data} readUnavailable={head.isError || m.isError || t.isError} />
        </div>
      </aside>
    </main>
  );
}
