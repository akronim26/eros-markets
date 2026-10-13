import { marginLensAbi, marginLensCode } from "@/abi/marginLens";
import { client } from "./public-client";
import { canonicalRead } from "./deployment-check";
import type { RiskParams } from "./capabilities";

export function healthAt(cash: bigint, lots: bigint, tick: number, secsToT: bigint, now: bigint, profile: RiskParams, block: bigint) {
  return canonicalRead(block, () => client.readContract({ code: marginLensCode, abi: marginLensAbi, functionName: "health", args: [cash, lots, BigInt(tick) * 10n ** 15n, secsToT, now, profile], blockNumber: block }));
}

/** Scan discrete prices using the actual kernel. No monotonicity assumption about custom profiles. */
export async function marginBoundaries(cash: bigint, lots: bigint, markTick: number, secsToT: bigint, now: bigint, profile: RiskParams, block: bigint) {
  return canonicalRead(block, async () => {
  const values = new Map<number, number>();
  // At most four simultaneous read-only calls, each evaluating at most 50 ticks.
  const starts = Array.from({ length: 20 }, (_, i) => i * 50 + 1);
  for (let offset = 0; offset < starts.length; offset += 4) await Promise.all(starts.slice(offset, offset + 4).map(async (first) => {
    const rows = await client.readContract({ code: marginLensCode, abi: marginLensAbi, functionName: "healthRange", args: [cash, lots, first, Math.min(999, first + 49), secsToT, now, profile], blockNumber: block });
    rows.forEach((row, i) => values.set(first + i, row.status));
  }));
  const nearest = (threshold: number) => [...values].filter(([, status]) => status >= threshold).sort(([a], [b]) => Math.abs(a - markTick) - Math.abs(b - markTick))[0]?.[0];
  return { block, mm: nearest(3), im: nearest(2) };
  });
}
