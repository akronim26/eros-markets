"use client";
import { useMemo } from "react";
import type { Address } from "viem";
import { useHistory } from "./history-reads";
import { INDEXER_URL } from "./history";
import { useLiveSeries, type Point, type Trade } from "./reads";

export function usePriceSeries(engine: Address, head?: bigint) {
  const live = useLiveSeries(engine, head);
  const history = useHistory(engine, undefined, undefined, head);
  const previous = useMemo(() => {
    const index: Point[] = [], perp: Point[] = [], trades: Trade[] = [];
    for (const e of history.data?.prices ?? []) {
      if (live.since !== undefined && BigInt(e.block) >= live.since) continue;
      const p = JSON.parse(e.payload), block = BigInt(e.block);
      if (e.kind === "ObservationAccepted") index.push({ valid: p.depthValid === true, t: Number(p.observedAt), v: Number(BigInt(p.priceWad) / 10n ** 12n) / 1e6, block });
      if (e.kind === "PerpObservationRecorded") perp.push({ valid: p.valid === true, t: Number(p.t), v: Number(BigInt(p.midWad) / 10n ** 12n) / 1e6, block });
      if (e.kind === "Fill") trades.push({ t: Number(e.timestamp), tick: Number(p.tick), size: BigInt(p.size), block, tx: e.txHash });
    }
    return { index, perp, trades };
  }, [history.data, live.since]);
  return { ...live, index: [...previous.index, ...live.index], perp: [...previous.perp, ...live.perp], trades: [...previous.trades, ...live.trades],
    historyStatus: !INDEXER_URL ? "Session history" : history.isError ? "History unavailable" : !history.data ? "Loading history…" : `History through ${history.data.progress}` };
}
