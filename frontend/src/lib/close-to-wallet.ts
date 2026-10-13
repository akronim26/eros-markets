import type { Abi, Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { vaultAbi } from "@/abi/vault";
import { client } from "./public-client";
import { readAssets } from "./market-discovery";
import { ownerTrader } from "./trader";

type SweepCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; label: string; validate?: (block: bigint) => Promise<void> };

/**
 * After a full close fills: release everything the engine allows out of this market, then withdraw it
 * to the connected wallet, so closing returns funds like a spot sale. Read at the current head, after the
 * close is final. A position that is still open (a partial fill) is left untouched with its margin.
 */
export async function closeToWalletCalls(engine: Address, owner: Address): Promise<{ calls: SweepCall[]; open: boolean }> {
  const block = await client.getBlockNumber();
  const assets = await readAssets(engine, block);
  const [traderId, free] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
    { address: engine, abi: engineAbi, functionName: "participantId", args: [owner] },
    { address: assets.vault, abi: vaultAbi, functionName: "freeAtoms", args: [owner] },
  ] });
  if (!traderId) return { calls: [], open: false };
  const preview = await client.readContract({ address: engine, abi: engineAbi, functionName: "previewAccount", args: [traderId], blockNumber: block });
  if (preview.positionLots !== 0n) return { calls: [], open: true };
  const release = preview.usableReleaseAtoms, total = free + release;
  const sdk = ownerTrader(engine, owner);
  const calls: SweepCall[] = [];
  if (release > 0n) calls.push({ ...(sdk.release(release) as unknown as SweepCall), label: "release to vault",
    validate: async (at) => {
      const [ok] = await client.readContract({ address: engine, abi: engineAbi, functionName: "previewRelease", args: [traderId, release], blockNumber: at });
      if (!ok) throw new Error("The market no longer permits this release. Refresh and use Manage collateral.");
    } });
  if (total > 0n) calls.push({ ...(sdk.withdraw(total) as unknown as SweepCall), label: "withdraw to wallet",
    validate: async (at) => {
      const now = await client.readContract({ address: assets.vault, abi: vaultAbi, functionName: "freeAtoms", args: [owner], blockNumber: at });
      if (now < total) throw new Error("Free vault balance changed. Refresh and withdraw from Manage collateral.");
    } });
  return { calls, open: false };
}
