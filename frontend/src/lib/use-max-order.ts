"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client, type MarketSnapshot, type TraderSnapshot } from "./reads";
import { readPinned } from "./pinned-read";
import { findMaxOrder } from "./max-order";
import { orderSizeBounds } from "./trade-view";

/** An on-demand, bounded capacity search. The ticket still previews the selected size again. */
export function useMaxOrder(input: {
  engine: Address; owner?: Address; market?: MarketSnapshot; trader?: TraderSnapshot;
  tick?: number; isBuy: boolean; reduceOnly: boolean; unavailable: boolean; inputRevision?: number;
}) {
  const { engine, owner, market, trader, tick, isBuy, reduceOnly, unavailable } = input;
  const account = trader?.account?.preview;
  const scope = [engine, owner, trader?.traderId, tick, isBuy, reduceOnly,
    account?.positionLots, account?.cashQ, account?.orders.bidLots, account?.orders.askLots,
    account?.orders.bidValueQ, account?.orders.askValueQ,
    account?.id.marketOrderEpoch, account?.id.profileHash, account?.id.stage, account?.id.pricingMode,
    market?.active, market?.halted, unavailable, input.inputRevision].join(":");
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const controller = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<{ scope: string; busy?: boolean; message?: string; error?: string }>();
  useEffect(() => () => { controller.current?.abort(); }, [scope]);
  const enabled = !!owner && !!account && !!trader?.traderId && !!tick && !!market?.active && !market.halted
    && trader.block === market.block && !unavailable;

  async function search(onSize: (lots: bigint) => void) {
    if (!enabled || !market || !trader || !account || tick === undefined) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ scope, busy: true });
    try {
      const bounds = orderSizeBounds({ positionLots: account.positionLots, isBuy, reduceOnly,
        minOrderLots: market.listing.minOrderLots, maxOrderLots: market.listing.maxOrderLots,
        reservedBidLots: account.orders.bidLots, reservedAskLots: account.orders.askLots });
      const pinned = await readPinned(market.block, () => findMaxOrder({ ...bounds, block: market.block, signal: abort.signal,
        preview: (lots, blockNumber) => client.readContract({ address: engine, abi: engineAbi, functionName: "previewOrder",
          args: [trader.traderId, isBuy ? 0 : 1, tick, lots, reduceOnly], blockNumber }),
      }));
      if (abort.signal.aborted || currentScope.current !== scope) return;
      if (pinned.value.lots > 0n) onSize(pinned.value.lots);
      setState({ scope, message: pinned.value.lots === 0n ? "No admissible size found at this price."
        : `Largest verified size at block ${pinned.block}. ${pinned.value.searchComplete ? "Capacity search complete." : "Search limit reached; more capacity may be available."} Fills depend on liquidity.` });
    } catch (error) {
      if (!abort.signal.aborted && currentScope.current === scope) setState({ scope, error: error instanceof Error ? error.message : "Capacity search unavailable. Try again." });
    }
  }
  return { enabled, search, ...(state?.scope === scope ? state : {}) };
}
