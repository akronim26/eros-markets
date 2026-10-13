import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client } from "./public-client";
import type { MarketSnapshot, TraderSnapshot } from "./reads";
import { pinnedReadCurrent, readPinned } from "./pinned-read";

/** Poll one exact order intent. New heads update the next read, not its cache identity. */
export function orderPreviewOptions(engine: Address, owner: Address | undefined, traderId: number, side: "buy" | "sell", tick: number, lots: bigint, reduceOnly: boolean, block: bigint) {
  return {
    queryKey: ["previewOrder", engine.toLowerCase(), owner?.toLowerCase(), traderId, side, tick, lots.toString(), reduceOnly] as const,
    refetchInterval: 4000,
    staleTime: 3500,
    queryFn: () => readPinned(block, () =>
      client.readContract({ address: engine, abi: engineAbi, functionName: "previewOrder", args: [traderId, side === "buy" ? 0 : 1, tick, lots, reduceOnly], blockNumber: block })),
  };
}

type PinnedPreview = Awaited<ReturnType<ReturnType<typeof orderPreviewOptions>["queryFn"]>>;

/** A quote may span a few heads; price changes are checked again before signing. */
export function orderPreviewCurrent(preview: PinnedPreview | undefined, market: MarketSnapshot | undefined, trader: TraderSnapshot | undefined, now = Date.now()) {
  if (!preview || !market || !trader?.account || trader.block !== market.block || !pinnedReadCurrent(preview, market.block, now)) return false;
  const previous = preview.value.id;
  const current = trader.account.preview.id;
  return previous.stage === current.stage && previous.pricingMode === current.pricingMode
    && previous.accountingState === current.accountingState && previous.profileHash === current.profileHash
    && previous.marketOrderEpoch === current.marketOrderEpoch
    && previous.indexAvailable === current.indexAvailable && previous.markAvailable === current.markAvailable;
}
