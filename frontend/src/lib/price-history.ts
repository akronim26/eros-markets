"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useHistory } from "./history-reads";
import { INDEXER_URL, validatedEvents, type HistoryEvent } from "./history";
import { useLiveSeries, type Point, type Trade } from "./reads";

export function usePriceSeries(engine: Address, head?: bigint) {
  const live = useLiveSeries(engine, head);
  const history = useHistory(engine, undefined, undefined, head);
  // Server-stored span of the same events, so the chart opens populated without an indexer.
  const stored = useQuery({ queryKey: ["stored-prices", engine.toLowerCase()], refetchInterval: 30000, retry: 2,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/price-history/${engine}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Stored history unavailable.");
      const body = await response.json() as { through: number; spanSeconds: number; prices: HistoryEvent[] };
      const prices = validatedEvents(body.prices, body.through);
      if (prices.some((e) => e.engine.toLowerCase() !== engine.toLowerCase())) throw new Error("Stored history is for another market.");
      return { ...body, prices };
    } });
  const source = history.data?.prices ?? stored.data?.prices;
  const previous = useMemo(() => {
    const index: Point[] = [], perp: Point[] = [], trades: Trade[] = [];
    for (const e of source ?? []) {
      if (live.since !== undefined && BigInt(e.block) >= live.since) continue;
      const p = JSON.parse(e.payload), block = BigInt(e.block);
      if (e.kind === "ObservationAccepted") index.push({ valid: p.depthValid === true, t: Number(p.observedAt), v: Number(BigInt(p.priceWad) / 10n ** 12n) / 1e6, block });
      if (e.kind === "PerpObservationRecorded") perp.push({ valid: p.valid === true, t: Number(p.t), v: Number(BigInt(p.midWad) / 10n ** 12n) / 1e6, block });
      if (e.kind === "Fill") trades.push({ t: Number(e.timestamp), tick: Number(p.tick), size: BigInt(p.size), block, tx: e.txHash });
    }
    return { index, perp, trades };
  }, [source, live.since]);
  return { ...live, index: [...previous.index, ...live.index], perp: [...previous.perp, ...live.perp], trades: [...previous.trades, ...live.trades],
    historyStatus: history.data ? `History through ${history.data.progress}`
      : stored.data ? `Stored history · last ${Math.round(stored.data.spanSeconds / 3600)}h`
      : stored.isPending || (INDEXER_URL && !history.isError) ? "Loading history…"
      : INDEXER_URL ? "History unavailable" : "Session history" };
}
