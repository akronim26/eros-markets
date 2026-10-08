"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Address, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";
import { vaultAbi } from "@/abi/vault";
import { resolveOracleBinding } from "./oracle-binding";
import { readOracleSnapshot } from "./oracle-reads";

import { client } from "./public-client";
import { readAssets } from "./market-discovery";
import { ensureNetwork, ensureDeployment, canonicalRead } from "./deployment-check";
import { bookTicks } from "./book-depth";
import { emptySeries, readLiveSeries } from "./live-series";
export { client };

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
export { erc20Abi };

/** Chain head, polled. Every snapshot pins to one block from here (frontend.md R3). */
export function useHead() {
  return useSticky(useQuery({
    queryKey: ["head"],
    queryFn: async () => {
      await ensureNetwork();
      const b = await client.getBlock({ blockTag: "finalized" });
      const age = Date.now() - Number(b.timestamp) * 1000;
      if (age < -5000 || age > 30000) throw new Error("RPC finalized head is stale or has an invalid timestamp.");
      return { number: b.number, timestamp: b.timestamp, at: Date.now() };
    },
    refetchInterval: 4000,
    staleTime: 3500,
  }));
}

/**
 * Keep the last successful block-pinned snapshot on screen when a refresh fails (public RPC hiccups),
 * so a transient error never regresses the UI to its loading state. The snapshot keeps its own block.
 */
function useSticky<T extends { data: unknown }>(q: T, scope = "public"): T {
  const last = useRef<{ scope: string; data: T["data"] }>({ scope, data: undefined });
  if (last.current.scope !== scope) last.current = { scope, data: undefined };
  if (q.data !== undefined) last.current.data = q.data;
  return { ...q, data: q.data ?? last.current.data };
}

export function useMarket(engine: Address, block: bigint | undefined) {
  return useSticky(useQuery(marketOptions(engine, block)), engine.toLowerCase());
}

/** Public market data is shared across wallets and never waits for an account read. */
export function marketOptions(engine: Address, block: bigint | undefined) {
  return {
    queryKey: ["market", engine.toLowerCase()],
    enabled: block !== undefined,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: async () => {
      await ensureDeployment(engine);
      return canonicalRead(block!, async anchor => ({ ...await readMarket(engine, block!), blockHash: anchor.hash }));
    },
  };
}

async function readMarket(engine: Address, block: bigint) {
      const c = { address: engine, abi: engineAbi } as const;
      const [
        active, halted, priceReady, risk, settlement, listing, bba, touch, depth, oi, participants,
        epoch, tariff, funding, profile, reserve, capBase, slacks, liqBudget, maxFills, freshness, leverageCaps,
      ] = await client.multicall({
        blockNumber: block,
        allowFailure: false,
        contracts: [
          { ...c, functionName: "active" },
          { ...c, functionName: "halted" },
          { ...c, functionName: "priceReady" },
          { ...c, functionName: "marketRiskView" },
          { ...c, functionName: "getSettlementStatus" },
          { ...c, functionName: "listing" },
          { ...c, functionName: "bestBidAsk" },
          { ...c, functionName: "touch" },
          { ...c, functionName: "bookDepth" },
          { ...c, functionName: "oiAllLots" },
          { ...c, functionName: "participantCount" },
          { ...c, functionName: "epoch" },
          { ...c, functionName: "tariff" },
          { ...c, functionName: "fundingFeatureEnabled" },
          { ...c, functionName: "activeProfile" },
          { ...c, functionName: "reserve" },
          { ...c, functionName: "reserveCapBaseQ" },
          { ...c, functionName: "coverageSlacks" },
          { ...c, functionName: "liquidationBlockBudget" },
          { ...c, functionName: "maxFills" },
          { ...c, functionName: "freshness" },
          { ...c, functionName: "leverageCaps" },
        ],
      });
      return {
        block: block!,
        active, halted, priceReady, risk, settlement, listing,
        bestBid: bba[0], bestAsk: bba[1],
        touch: { bid: touch[0], bidSize: touch[1], ask: touch[2], askSize: touch[3] },
        depth, oiLots: oi, participants,
        epoch: { id: epoch[0], start: epoch[1], end: epoch[2], rate: epoch[5], stopped: epoch[6] },
        tariff: { h0: tariff[0], h1: tariff[1], load: tariff[2] },
        fundingEnabled: funding, profile,
        leverageCaps: { long: leverageCaps[0], short: leverageCaps[1] },
        reserve: { lots: reserve[0], cashQ: reserve[1] },
        reserveCapBaseQ: capBase,
        slacks: { s0: slacks[0], s1: slacks[1] },
        liqBudget: { cap: liqBudget[0], remaining: liqBudget[1] },
        maxFills, freshness: { freshThrough: freshness[0], movementRestricted: freshness[2] },
      };
}
export type MarketSnapshot = Awaited<ReturnType<typeof readMarket>> & { blockHash: Hex };

export function useTrader(engine: Address, owner: Address | undefined, block: bigint | undefined) {
  return useSticky(useQuery({
    queryKey: ["trader", engine, owner],
    enabled: !!owner && block !== undefined,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: () => canonicalRead(block!, () => readTrader(engine, owner!, block!)),
  }), `${engine.toLowerCase()}:${owner?.toLowerCase() ?? "disconnected"}`);
}

async function readTrader(engine: Address, owner: Address, block: bigint) {
      const assets = await readAssets(engine, block!);
      const [traderId, free, wallet, allowance] = await client.multicall({
        blockNumber: block,
        allowFailure: false,
        contracts: [
          { address: engine, abi: engineAbi, functionName: "participantId", args: [owner!] },
          { address: assets.vault, abi: vaultAbi, functionName: "freeAtoms", args: [owner!] },
          { address: assets.token, abi: erc20Abi, functionName: "balanceOf", args: [owner!] },
          { address: assets.token, abi: erc20Abi, functionName: "allowance", args: [owner!, assets.vault] },
        ],
      });
      if (traderId === 0) return { block: block!, assets, traderId, free, wallet, allowance, account: null };
      const [preview, riskView, claimable, claimed] = await client.multicall({
        blockNumber: block,
        allowFailure: false,
        contracts: [
          { address: engine, abi: engineAbi, functionName: "previewAccount", args: [traderId] },
          { address: engine, abi: engineAbi, functionName: "accountRiskView", args: [traderId] },
          { address: engine, abi: engineAbi, functionName: "claimableAtoms", args: [owner!] },
          { address: engine, abi: engineAbi, functionName: "traderClaimed", args: [owner!] },
        ],
      });
      return { block: block!, assets, traderId, free, wallet, allowance, account: { preview, riskView, claimable, claimed } };
}
export type TraderSnapshot = NonNullable<ReturnType<typeof useTrader>["data"]>;

/** Pair owner state with the exact block of a verified public snapshot.
 * The public query can finish first; it stays shared across wallet changes.
 * Never combine independently polled latest market/account values for an action.
 */
export function tradingSnapshotOptions(engine: Address, owner: Address | undefined, block: bigint | undefined,
  readPublicMarket: () => Promise<MarketSnapshot> = marketOptions(engine, block).queryFn) {
  return {
    queryKey: ["trading-snapshot", engine.toLowerCase(), owner?.toLowerCase()],
    enabled: block !== undefined,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: async () => {
      const market = await readPublicMarket();
      if (!owner) return { market, trader: undefined, accountError: false };
      return canonicalRead(market.block, async () => {
        try {
          const trader = await readTrader(engine, owner, market.block);
          return { market, trader, accountError: false };
        } catch {
          return { market, trader: undefined, accountError: true };
        }
      }, market.blockHash);
    },
  };
}

export function useTradingSnapshot(engine: Address, owner: Address | undefined, block: bigint | undefined) {
  const qc = useQueryClient();
  return useSticky(useQuery(tradingSnapshotOptions(engine, owner, block,
    () => qc.fetchQuery(marketOptions(engine, block)))),
    `${engine.toLowerCase()}:${owner?.toLowerCase() ?? "disconnected"}`);
}


export type Level = { tick: number; bidLots: bigint; askLots: bigint };

/** Gross resting size per tick in a window around the touch (may include lazily dead orders). */
export function useLadder(engine: Address, block: bigint | undefined, bestBid: number, bestAsk: number, span = 30) {
  return useQuery(ladderOptions(engine, block, bestBid, bestAsk, span));
}

export function ladderOptions(engine: Address, block: bigint | undefined, bestBid: number, bestAsk: number, span = 30) {
  const empty = bestBid === 0 && bestAsk === 0;
  return {
    queryKey: ["ladder", engine, bestBid, bestAsk, span],
    enabled: block !== undefined,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: async (): Promise<Level[]> => {
      if (empty) return [];
      return canonicalRead(block!, async () => {
      const ticks = bookTicks(bestBid, bestAsk, span);
      const res = await client.multicall({
        blockNumber: block,
        allowFailure: false,
        contracts: ticks.flatMap((t) => [
          { address: engine, abi: engineAbi, functionName: "getLevel", args: [true, t] } as const,
          { address: engine, abi: engineAbi, functionName: "getLevel", args: [false, t] } as const,
        ]),
      });
      return ticks.map((tick, i) => ({ tick, bidLots: res[i * 2].size, askLots: res[i * 2 + 1].size }));
      });
    },
  };
}

export type { Point, Trade } from "./live-series";

/** Keep pending reads and accumulated history scoped to one engine, even during navigation. */
export function useLiveSeries(engine: Address, head: bigint | undefined) {
  const scope = engine.toLowerCase();
  const context = useRef({ scope, busy: false, series: emptySeries() });
  if (context.current.scope !== scope) context.current = { scope, busy: false, series: emptySeries() };
  const [result, setResult] = useState({ scope, series: emptySeries() });
  useEffect(() => {
    const current = context.current;
    if (head === undefined || current.busy) return;
    current.busy = true;
    void readLiveSeries(engine, head, current.series).then((series) => {
      if (context.current !== current) return;
      current.series = series;
      setResult({ scope, series });
    }).catch((e: unknown) => {
      if (context.current !== current) return;
      current.series = { ...current.series, error: e instanceof Error ? e.message : String(e) };
      setResult({ scope, series: current.series });
    }).finally(() => { current.busy = false; });
  }, [engine, head, scope]);
  return result.scope === scope ? result.series : emptySeries();
}

export function useOracleMarket(id: Hex, engine?: string) {
  const oracle = resolveOracleBinding(id, engine);
  return useQuery({
    queryKey: ["oracle-market", oracle.marketRegistry, oracle.resolutionOracle, id, oracle.engine],
    refetchInterval: 15000,
    queryFn: async () => {
      await ensureDeployment(oracle.engine ?? oracle.marketRegistry);
      const head = await client.getBlock({ blockTag: "finalized" });
      return readOracleSnapshot(id, oracle, head.number, head.timestamp);
    },
  });
}
