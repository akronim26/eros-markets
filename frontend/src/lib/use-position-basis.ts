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

export function usePositionBasis(input: {
  engine: Address; owner?: Address; traderId: number; history?: HistorySnapshot;
  block?: bigint; positionLots?: bigint; enabled?: boolean;
}): PositionBasis {
  const { engine, owner, traderId, history, block, positionLots } = input;
  const normalized = useMemo(() => history
    ? historyPositionFills(history.events, traderId, history.makerOrders ?? [])
    : undefined, [history, traderId]);
  const historyBlock = history && Number.isSafeInteger(history.progress) && history.progress >= 0 ? BigInt(history.progress) : undefined;
  const ready = input.enabled !== false && !!owner && traderId > 0 && block !== undefined && positionLots !== undefined
    && !!history?.complete && history.directionsComplete !== false && normalized?.allPositionChangesKnown === true && historyBlock !== undefined && historyBlock <= block;
  const versions = useQuery({
    queryKey: ["position-basis-versions", chain.id, engine.toLowerCase(), owner?.toLowerCase(), historyBlock?.toString(), block?.toString()],
    enabled: ready,
    staleTime: 0,
    retry: 1,
    queryFn: async () => {
      const read = (at: bigint) => canonicalRead(at, async (): Promise<PositionVersionSnapshot> => {
        const account = await client.readContract({ address: engine, abi: engineAbi, functionName: "account", args: [owner!], blockNumber: at });
        return { block: at, positionLots: account.value.lots, positionVersion: account.positionVersion };
      });
      const [historical, current] = historyBlock === block
        ? await read(block!).then(value => [value, value])
        : await Promise.all([read(historyBlock!), read(block!)]);
      return { historical, current };
    },
  });
  return useMemo((): PositionBasis => {
    if (!ready || !normalized || historyBlock === undefined || block === undefined || positionLots === undefined) {
      return { available: false, reason: "Complete, direction-resolved fill history is unavailable" };
    }
    if (versions.isError) return { available: false, reason: "Could not verify fill history against the account" };
    if (!versions.data || versions.data.current.block !== block || versions.data.historical.block !== historyBlock) {
      return { available: false, reason: "Verifying entry basis against the account" };
    }
    const { historical, current } = versions.data;
    if (current.positionLots !== positionLots) return { available: false, reason: "Position snapshot changed; refresh before estimating P&L" };
    const basis = reconstructPositionBasis({ ...normalized, complete: true, throughBlock: historyBlock,
      snapshotBlock: historyBlock, expectedPositionLots: historical.positionLots });
    return advancePositionBasis(basis, historical, current, normalized.fills.length);
  }, [ready, normalized, historyBlock, block, positionLots, versions.isError, versions.data]);
}
