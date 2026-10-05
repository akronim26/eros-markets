"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { engineAbi } from "@/abi/engine";
import { vaultAbi } from "@/abi/vault";
import { resolutionOracleAbi } from "@/abi/resolutionOracle";
import { marketRegistryAbi } from "@/abi/marketRegistry";
import { chain, LOG_BLOCK_CAP } from "@/config/chain";
import { deployment } from "@/config/deployment";

export const client = createPublicClient({ chain, transport: http(undefined, { batch: { wait: 16 }, retryCount: 3, retryDelay: 400 }) });

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
      const b = await client.getBlock({ blockTag: "latest" });
      return { number: b.number, timestamp: b.timestamp, at: Date.now() };
    },
    refetchInterval: 1500,
    staleTime: 1000,
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
  return useSticky(useQuery({
    queryKey: ["market", engine, block?.toString()],
    enabled: block !== undefined,
    queryFn: async () => {
      const c = { address: engine, abi: engineAbi } as const;
      const [
        active, halted, priceReady, risk, settlement, listing, bba, touch, depth, oi, participants,
        epoch, tariff, funding, profile, reserve, capBase, slacks, liqBudget, maxFills, freshness,
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
        reserve: { lots: reserve[0], cashQ: reserve[1] },
        reserveCapBaseQ: capBase,
        slacks: { s0: slacks[0], s1: slacks[1] },
        liqBudget: { cap: liqBudget[0], remaining: liqBudget[1] },
        maxFills, freshness: { freshThrough: freshness[0], movementRestricted: freshness[2] },
      };
    },
  }), engine.toLowerCase());
}
export type MarketSnapshot = NonNullable<ReturnType<typeof useMarket>["data"]>;

export function useTrader(engine: Address, owner: Address | undefined, block: bigint | undefined) {
  return useSticky(useQuery({
    queryKey: ["trader", engine, owner, block?.toString()],
    enabled: !!owner && block !== undefined,
    queryFn: async () => {
      const [traderId, free, wallet, allowance] = await client.multicall({
        blockNumber: block,
        allowFailure: false,
        contracts: [
          { address: engine, abi: engineAbi, functionName: "participantId", args: [owner!] },
          { address: deployment.risk.collateralVault, abi: vaultAbi, functionName: "freeAtoms", args: [owner!] },
          { address: deployment.risk.collateralToken, abi: erc20Abi, functionName: "balanceOf", args: [owner!] },
          { address: deployment.risk.collateralToken, abi: erc20Abi, functionName: "allowance", args: [owner!, deployment.risk.collateralVault] },
        ],
      });
      if (traderId === 0) return { block: block!, traderId, free, wallet, allowance, account: null };
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
      return { block: block!, traderId, free, wallet, allowance, account: { preview, riskView, claimable, claimed } };
    },
  }), `${engine.toLowerCase()}:${owner?.toLowerCase() ?? "disconnected"}`);
}
export type TraderSnapshot = NonNullable<ReturnType<typeof useTrader>["data"]>;

export type Level = { tick: number; bidLots: bigint; askLots: bigint };

/** Gross resting size per tick in a window around the touch (may include lazily dead orders). */
export function useLadder(engine: Address, block: bigint | undefined, bestBid: number, bestAsk: number, span = 30) {
  const empty = bestBid === 0 && bestAsk === 0;
  return useQuery({
    queryKey: ["ladder", engine, block?.toString(), bestBid, bestAsk],
    enabled: block !== undefined && !empty,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<Level[]> => {
      const mid = bestBid && bestAsk ? Math.round((bestBid + bestAsk) / 2) : bestBid || bestAsk;
      const lo = Math.max(1, mid - span);
      const hi = Math.min(999, mid + span);
      const ticks = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      const res = await client.multicall({
        blockNumber: block,
        allowFailure: false,
        contracts: ticks.flatMap((t) => [
          { address: engine, abi: engineAbi, functionName: "getLevel", args: [true, t] } as const,
          { address: engine, abi: engineAbi, functionName: "getLevel", args: [false, t] } as const,
        ]),
      });
      return ticks.map((tick, i) => ({ tick, bidLots: res[i * 2].size, askLots: res[i * 2 + 1].size }));
    },
  });
}

export type Point = { t: number; v: number; block: bigint };
export type Trade = { t: number; tick: number; size: bigint; block: bigint; tx: Hex };

const OBS = parseAbiItem(
  "event ObservationAccepted(bytes32 indexed sourceId, uint64 indexed sequence, uint64 observedAt, uint64 publishedAt, uint64 acceptedAt, uint256 priceWad, bool depthValid, bytes32 payloadDigest)",
);
const PERP = parseAbiItem("event PerpObservationRecorded(uint64 t, uint256 midWad, bool valid, int256 basisWad, bool basisValid)");
const FILL = parseAbiItem(
  "event Fill(uint32 indexed makerOrder, uint32 maker, uint32 taker, uint16 tick, uint64 size, uint256 makerFeeQ, uint256 takerFeeQ)",
);

/**
 * Live series accumulated while the page is open, in ≤100-block windows (public RPC cap).
 * Full history needs the indexer (frontend.md §14); `since` says how far back this goes.
 */
export function useLiveSeries(engine: Address, head: bigint | undefined) {
  const [state, setState] = useState<{ index: Point[]; perp: Point[]; trades: Trade[]; since?: bigint; error?: string }>({
    index: [],
    perp: [],
    trades: [],
  });
  const cursor = useRef<bigint | undefined>(undefined);
  const busy = useRef(false);

  useEffect(() => {
    if (head === undefined || busy.current) return;
    const from = cursor.current === undefined ? (head > LOG_BLOCK_CAP ? head - LOG_BLOCK_CAP + 1n : 0n) : cursor.current + 1n;
    if (from > head) return;
    const to = from + LOG_BLOCK_CAP - 1n < head ? from + LOG_BLOCK_CAP - 1n : head;
    busy.current = true;
    (async () => {
      try {
        const [obs, perp, fills] = await Promise.all([
          client.getLogs({ address: engine, event: OBS, fromBlock: from, toBlock: to }),
          client.getLogs({ address: engine, event: PERP, fromBlock: from, toBlock: to }),
          client.getLogs({ address: engine, event: FILL, fromBlock: from, toBlock: to }),
        ]);
        cursor.current = to;
        setState((s) => ({
          since: s.since ?? from,
          index: [...s.index, ...obs.map((l) => ({ t: Number(l.args.observedAt), v: Number(l.args.priceWad! / 10n ** 12n) / 1e6, block: l.blockNumber! }))].slice(-2000),
          perp: [...s.perp, ...perp.filter((l) => l.args.valid).map((l) => ({ t: Number(l.args.t), v: Number(l.args.midWad! / 10n ** 12n) / 1e6, block: l.blockNumber! }))].slice(-2000),
          trades: [...s.trades, ...fills.map((l) => ({ t: 0, tick: l.args.tick!, size: l.args.size!, block: l.blockNumber!, tx: l.transactionHash! }))].slice(-500),
        }));
      } catch (e) {
        setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        busy.current = false;
      }
    })();
  }, [engine, head]);

  return state;
}

export function useOracleMarket(id: Hex) {
  return useQuery({
    queryKey: ["oracle-market", id],
    refetchInterval: 15000,
    queryFn: async () => {
      const o = deployment.oracle;
      const [question, rules, core, resolution, evidenceURI, block] = await Promise.all([
        client.readContract({ address: o.marketRegistry, abi: marketRegistryAbi, functionName: "getQuestion", args: [id] }),
        client.readContract({ address: o.marketRegistry, abi: marketRegistryAbi, functionName: "getRules", args: [id] }),
        client.readContract({ address: o.marketRegistry, abi: marketRegistryAbi, functionName: "getMarketCore", args: [id] }),
        client.readContract({ address: o.resolutionOracle, abi: resolutionOracleAbi, functionName: "getResolution", args: [id] }),
        client.readContract({ address: o.resolutionOracle, abi: resolutionOracleAbi, functionName: "evidenceURIOf", args: [id] }),
        client.getBlockNumber(),
      ]);
      return { id, question, rules, core, resolution, evidenceURI, block };
    },
  });
}
