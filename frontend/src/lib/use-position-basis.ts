"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { chain } from "@/config/chain";
import { client } from "./public-client";
import { canonicalRead } from "./deployment-check";
import type { HistorySnapshot } from "./history";
import { historyPositionFills } from "./history-direction";
import { advancePositionBasis, reconstructPositionBasis, type PositionBasis, type PositionVersionSnapshot } from "./trade-estimate";

/** Historical proof is independent of the live head. Poll canonicality without
 * abandoning a slow archive read whenever the current trader snapshot advances.
 */
export function positionBasisHistoryOptions(engine: Address, owner: Address | undefined, block: bigint | undefined) {
  return {
    queryKey: ["position-basis-history", chain.id, engine.toLowerCase(), owner?.toLowerCase(), block?.toString()],
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: () => canonicalRead(block!, async (anchor) => {
      const account = await client.readContract({ address: engine, abi: engineAbi, functionName: "account", args: [owner!], blockNumber: block! });
      return { block: block!, blockHash: anchor.hash, positionLots: account.value.lots, positionVersion: account.positionVersion };
    }),
  };
}

export function usePositionBasis(input: {
  engine: Address; owner?: Address; traderId: number; history?: HistorySnapshot;
  block?: bigint; positionLots?: bigint; positionVersion?: bigint; enabled?: boolean;
}): PositionBasis {
  const { engine, owner, traderId, history, block, positionLots, positionVersion } = input;
  const normalized = useMemo(() => {
    if (!history) return;
    let lastFillBlock: bigint | undefined;
    for (const event of history.events) {
      if (event.kind !== "Fill") continue;
      if (!Number.isSafeInteger(event.block) || event.block < 0) return;
      const fillBlock = BigInt(event.block);
      if (lastFillBlock === undefined || fillBlock > lastFillBlock) lastFillBlock = fillBlock;
    }
    return { ...historyPositionFills(history.events, traderId, history.makerOrders ?? []), lastFillBlock };
  }, [history?.events, history?.makerOrders, traderId]);
  const historyThroughBlock = history && Number.isSafeInteger(history.progress) && history.progress >= 0 ? BigInt(history.progress) : undefined;
  // The last fill is a stable anchor even when the indexer watermark advances.
  // Historical version == fill count, then current version equality, proves that
  // no unrepresented posting occurred before or after this anchor.
  const historyBlock = normalized?.lastFillBlock;
  const ready = input.enabled !== false && !!owner && traderId > 0 && block !== undefined && positionLots !== undefined && positionVersion !== undefined
    && !!history?.complete && history.directionsComplete !== false && normalized?.allPositionChangesKnown === true
    && historyBlock !== undefined && historyThroughBlock !== undefined && historyBlock <= historyThroughBlock && historyThroughBlock <= block;
  const proof = useQuery({ ...positionBasisHistoryOptions(engine, owner, historyBlock), enabled: ready });
  // Replay only when historical evidence changes, not on every current snapshot.
  const basis = useMemo((): PositionBasis => {
    if (!ready || !normalized || historyBlock === undefined) {
      return { available: false, reason: "Complete, direction-resolved fill history is unavailable" };
    }
    if (proof.isError) return { available: false, reason: "Could not verify fill history against the account" };
    if (!proof.data || proof.data.block !== historyBlock) {
      return { available: false, reason: "Verifying entry basis against the account" };
    }
    return reconstructPositionBasis({ ...normalized, complete: true, throughBlock: historyBlock,
      snapshotBlock: historyBlock, expectedPositionLots: proof.data.positionLots });
  }, [ready, normalized, historyBlock, proof.isError, proof.data]);
  if (!basis.available || !ready || !proof.data || !normalized) return basis;
  // This version came from the same multicall/canonical block as the displayed
  // position. Unchanged lots alone cannot hide an intervening close/reopen.
  const current: PositionVersionSnapshot = { block: block!, positionLots: positionLots!, positionVersion: positionVersion! };
  return advancePositionBasis(basis, proof.data, current, normalized.fills.length);
}
