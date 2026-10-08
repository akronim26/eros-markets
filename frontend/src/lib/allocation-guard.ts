import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client } from "./public-client";
import { PublicError } from "./public-error";

type AllocationState = {
  active: boolean;
  halted: boolean;
  risk: { accountingState: number; stage: number; pendingWork: number };
  work?: number;
};

/** Mirrors ClearingCore.onAllocate/_live without making price readiness a funding gate. */
export function allocationBlocker(market: AllocationState): string | undefined {
  if (market.halted || market.risk.stage >= 4) return "Market halted";
  if (market.work !== undefined && market.work !== 0) return "Market maintenance pending";
  // Inactive engines report derived ROLLOVER_SWEEP even though no epoch exists yet.
  // OnAllocate allows preactivation funding when raw accounting work is READY.
  if (market.active && (market.risk.accountingState !== 0 || (market.risk.pendingWork & 1) !== 0)) {
    return "Market maintenance pending";
  }
}

async function readAllocationState(engine: Address, block: bigint): Promise<AllocationState> {
  const c = { address: engine, abi: engineAbi } as const;
  const [active, halted, risk, work] = await client.multicall({
    blockNumber: block, allowFailure: false,
    contracts: [
      { ...c, functionName: "active" }, { ...c, functionName: "halted" },
      { ...c, functionName: "marketRiskView" }, { ...c, functionName: "work" },
    ],
  });
  return { active, halted, risk, work };
}

/** Every funding step rechecks the exact block used by the wallet simulation. */
export async function validateAllocation(engine: Address, block: bigint, read = readAllocationState): Promise<void> {
  const reason = allocationBlocker(await read(engine, block));
  if (reason) throw new PublicError(`${reason}. Funding is paused. Free vault collateral can still be withdrawn.`);
}
