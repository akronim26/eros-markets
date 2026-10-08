"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useHead, useLadder, useMarket, useTradingSnapshot } from "@/lib/reads";
import { usePriceSeries } from "@/lib/price-history";
import type { MarketManifest } from "@/config/deployment";
import { wadToUnit } from "@/lib/units";
import { PriceAxis } from "./price-axis";
import { OrderBook, type BookPriceIntent } from "./order-book";
import { closeIntent, type CloseIntent } from "@/lib/trade-intent";
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

const TABS = ["Position", "Open orders", "History", "Protection"] as const;
const DETAILS = ["Market info", "Risk", "Liquidity", "Resolution", "Operations"] as const;
type Tab = (typeof TABS)[number] | (typeof DETAILS)[number];

export function Terminal({ manifest }: { manifest: MarketManifest }) {
  const tabsId = useId();
  const ticketRef = useRef<HTMLElement>(null);
  const head = useHead();
  const block = head.data?.number;
  const owner = useOwner();
  const market = useMarket(manifest.engine, block);
  const snapshot = useTradingSnapshot(manifest.engine, owner.address, block);
  const md = market.data;
  const actionMarket = snapshot.data?.market;
  const trader = snapshot.data?.trader;
  const publicUnavailable = head.isError || market.isError;
  const readUnavailable = publicUnavailable || snapshot.isError || !!snapshot.data?.accountError;
  const ladder = useLadder(manifest.engine, md?.block, md?.bestBid ?? 0, md?.bestAsk ?? 0);
  const live = usePriceSeries(manifest.engine, block);
  const [intent, setIntent] = useState<CloseIntent>();
  const [bookPrice, setBookPrice] = useState<BookPriceIntent>();
  const [tab, setTab] = useState<Tab>("Position");
  useEffect(() => setIntent(undefined), [owner.address]);
  const primaryIndex = TABS.findIndex(value => value === tab);
  const emptyReason = !md ? "Loading market prices…"
    : manifest.archived ? "Historical prices only."
    : !md.active ? "Prices appear when trading opens."
    : "Waiting for fresh market prices.";

  function reduce(bps: number) {
    if (readUnavailable || !actionMarket || trader?.block !== actionMarket.block || !trader?.account?.preview.positionLots) return;
    setIntent(closeIntent(trader.account.preview.positionLots, actionMarket.bestBid, actionMarket.bestAsk, bps));
    ticketRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
    ticketRef.current?.focus({ preventScroll: true });
  }

  return <main aria-label="Trading terminal"
    data-market-state={publicUnavailable ? "error" : md ? "ready" : "loading"}
    data-account-state={!owner.address ? "disconnected" : readUnavailable ? "error" : trader ? "ready" : "loading"}
    className={cx(styles.terminal, "mx-2 mb-2 bg-ground md:mx-3 md:mb-3")}>
    <div className={styles.marketBar}>
      <Link href="/markets" aria-label="Back to all markets" className="flex min-h-11 shrink-0 items-center gap-2 px-3 text-xs text-fg-2 hover:bg-hover hover:text-fg">
        <ArrowLeft size={15} aria-hidden /><span className="hidden sm:inline">Markets</span>
      </Link>
      <MarketHeader manifest={manifest} m={md} source={live.index} readError={!!live.error || publicUnavailable} />
    </div>
    {manifest.archived && <p role="status" className="border-x border-b border-line px-3 py-2 text-xs text-fg-2">Archived market. New positions are disabled; existing positions and funds remain accessible.</p>}
    {(readUnavailable || ladder.isError) && <p role="alert" className="flex flex-wrap items-center gap-2 border-x border-b border-line px-3 py-2 text-xs text-signal-text">Connection interrupted. Refresh before trading.<button className="underline" onClick={() => { void head.refetch(); void market.refetch(); void snapshot.refetch(); void ladder.refetch(); }}>Retry</button></p>}

    <div className={styles.workspace}>
      <div className={styles.chart} aria-busy={!md && !publicUnavailable}>
        <PriceAxis index={live.index} perp={live.perp}
          markUnit={md?.risk.markAvailable ? wadToUnit(md.risk.markWad) : undefined}
          indexUnit={md?.risk.indexAvailable ? wadToUnit(md.risk.indexWad) : undefined}
          emptyTitle={!md ? "Loading market" : manifest.archived ? "Market archived" : !md.active ? "Trading has not opened" : "Waiting for price"}
          emptyReason={emptyReason} historyStatus={live.historyStatus} readError={!!live.error || publicUnavailable} />
      </div>

      <aside ref={ticketRef} tabIndex={-1} className={styles.trade} aria-label="Trade">
        <Ticket key={owner.address ?? "disconnected"} engine={manifest.engine} market={actionMarket} trader={trader} intent={intent} bookPrice={bookPrice} readUnavailable={readUnavailable} />
        <div className="mt-auto border-t border-line">
          <AccountPanel engine={manifest.engine} m={actionMarket} t={trader} readUnavailable={readUnavailable} />
        </div>
      </aside>

      <div className={styles.book}
        data-book-state={ladder.isError || publicUnavailable ? "error" : md && ladder.data ? "ready" : "loading"}
        aria-busy={!publicUnavailable && !ladder.isError && (!md || !ladder.data)}>
        <OrderBook levels={ladder.isError ? [] : ladder.data ?? []} bestBid={md?.bestBid ?? 0} bestAsk={md?.bestAsk ?? 0}
          emptyReason={ladder.isError || publicUnavailable ? "Book unavailable" : !md || (!ladder.data && !!(md.bestBid || md.bestAsk)) ? "Loading book…" : "No resting orders"}
          onPrice={tick => setBookPrice({ tick, nonce: Date.now() })} />
      </div>

      <section className={styles.activity} aria-label="Your trading activity">
        <div className={styles.activityBar}>
          <div className="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Trading activity" onKeyDown={selectionKeys}>
            {TABS.map((value, index) => <button key={value} role="tab" id={`${tabsId}-${index}`} aria-controls={`${tabsId}-panel`}
              tabIndex={tab === value || (primaryIndex < 0 && index === 0) ? 0 : -1} aria-selected={tab === value}
              onClick={() => setTab(value)} className={cx("relative min-h-11 shrink-0 px-3 text-xs transition-colors", tab === value ? "text-fg" : "text-fg-3 hover:text-fg")}>
              {value}{tab === value && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-signal" aria-hidden />}
            </button>)}
          </div>
          <select id={`${tabsId}-details`} aria-label="More market details" value={primaryIndex < 0 ? tab : ""}
            className="min-h-11 max-w-36 cursor-pointer border-l border-line bg-ground px-2 text-xs text-fg-3 focus:text-fg"
            onChange={event => { if (event.target.value) setTab(event.target.value as Tab); }}>
            <option value="" disabled>Market details</option>
            {DETAILS.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div className={styles.activityContent} role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={primaryIndex < 0 ? `${tabsId}-details` : `${tabsId}-${primaryIndex}`} tabIndex={0}>
          {tab === "Position" ? <PositionPanel m={actionMarket} t={trader} onReduce={readUnavailable ? undefined : reduce} />
            : tab === "Open orders" || tab === "History" ? (owner.address && !trader
              ? <p role="status" className="p-4 text-xs text-fg-3">{readUnavailable ? "Account unavailable. Retry to refresh." : "Reading your account…"}</p>
              : tab === "Open orders" ? <OpenOrders engine={manifest.engine} traderId={trader?.traderId} block={actionMarket?.block} readUnavailable={readUnavailable} />
              : <AccountHistory engine={manifest.engine} traderId={trader?.traderId} block={actionMarket?.block} />)
            : tab === "Market info" ? <><MarketInfo manifest={manifest} m={md} /><details className="border-t border-line"><summary className="cursor-pointer px-4 py-3 text-xs text-fg-3">Trading deadlines</summary><DeadlineStrip m={md} now={head.data?.timestamp} /></details></>
            : tab === "Protection" ? (actionMarket ? <ProtectionPanel key={owner.address ?? "disconnected"} engine={manifest.engine} m={actionMarket} t={trader} readUnavailable={readUnavailable} /> : <p className="p-4 text-xs text-fg-3">Loading protection…</p>)
            : tab === "Risk" ? (actionMarket ? <RiskPanel key={`${manifest.engine}:${owner.address ?? "disconnected"}`} m={actionMarket} t={trader} /> : <p className="p-4 text-xs text-fg-3">Loading risk…</p>)
            : tab === "Liquidity" ? (actionMarket ? <ReservePanel engine={manifest.engine} m={actionMarket} t={trader} readUnavailable={readUnavailable} /> : <p className="p-4 text-xs text-fg-3">Loading liquidity…</p>)
            : tab === "Operations" ? (actionMarket ? <OperationsPanel engine={manifest.engine} m={actionMarket} readUnavailable={readUnavailable} /> : <p className="p-4 text-xs text-fg-3">Loading operations…</p>)
            : manifest.oracleMarketId ? <OracleMarket id={manifest.oracleMarketId} engine={manifest.engine} /> : <p className="p-4 text-xs text-fg-3">This test market uses manual settlement.</p>}
        </div>
      </section>
    </div>
  </main>;
}
