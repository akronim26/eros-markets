"use client";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { nativeBinding, nativeBindingForVault, type NativeBinding } from "@/config/native";
import { client } from "./public-client";
import { ensureDeployment } from "./deployment-check";
import { PublicError } from "./public-error";
import type { ResolutionEvent } from "@/server/resolution-events";

/**
 * A native vault is not in the reviewed oracle manifest, so it is verified separately before any read
 * is trusted or any call is signed: reviewed codehash, bound to this verified engine, and holding the
 * reviewed YES/NO tokens and collateral.
 */
const verified = new Map<string, Promise<void>>();
export function ensureNativeVault(vault: Address): Promise<void> {
  const b = nativeBindingForVault(vault);
  if (!b) return Promise.reject(new PublicError("Contract is not part of a reviewed deployment."));
  const key = vault.toLowerCase();
  let check = verified.get(key);
  if (!check) {
    check = (async () => {
      await ensureDeployment(b.engine);
      const [code, engine, yes, no, collateral, marketId] = await Promise.all([
        client.getCode({ address: b.vault }),
        ...(["engine", "yes", "no", "collateral", "marketId"] as const).map((functionName) => client.readContract({ address: b.vault, abi: nativeVaultAbi, functionName })),
      ]);
      const { keccak256 } = await import("viem");
      if (!code || keccak256(code) !== b.vaultCodehash) throw new PublicError("Native vault code does not match the reviewed deployment.");
      const same = (a: unknown, x: string) => String(a).toLowerCase() === x.toLowerCase();
      if (!same(engine, b.engine) || !same(yes, b.yesToken) || !same(no, b.noToken) || !same(collateral, b.collateral) || !same(marketId, b.marketId))
        throw new PublicError("Native vault binding does not match the reviewed deployment.");
    })();
    check.catch(() => verified.delete(key));
    verified.set(key, check);
  }
  return check;
}

export type NativeSnapshot = {
  binding: NativeBinding & { engine: Address }; block: bigint;
  resolved: boolean; payoutYesWad: bigint; outstandingSets: bigint; totalRedeemed: bigint; issuanceOpen: boolean;
  wallet?: { yes: bigint; no: bigint; redeemable: bigint };
};

export async function readNative(engine: Address, owner: Address | undefined, block: bigint): Promise<NativeSnapshot | undefined> {
  const found = nativeBinding(engine);
  if (!found) return undefined;
  const binding = { ...found, engine: found.engine as Address };
  await ensureNativeVault(binding.vault);
  const v = { address: binding.vault, abi: nativeVaultAbi } as const;
  const [resolved, payoutYesWad, outstandingSets, totalRedeemed, issuanceOpen] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
    { ...v, functionName: "resolved" }, { ...v, functionName: "payoutYesWad" }, { ...v, functionName: "outstandingSets" },
    { ...v, functionName: "totalRedeemedAtoms" }, { ...v, functionName: "issuanceOpen" },
  ] });
  let wallet: NativeSnapshot["wallet"];
  if (owner) {
    const [yes, no] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
      { address: binding.yesToken, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: binding.noToken, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
    ] });
    // Same single floor as NativeOutcomeVault.redeemValue.
    const redeemable = resolved ? (yes * payoutYesWad + no * (10n ** 18n - payoutYesWad)) / 10n ** 18n : 0n;
    wallet = { yes, no, redeemable };
  }
  return { binding, block, resolved, payoutYesWad, outstandingSets, totalRedeemed, issuanceOpen, wallet };
}

export function useNative(engine: Address, owner: Address | undefined, block: bigint | undefined) {
  return useQuery({ queryKey: ["native", engine.toLowerCase(), owner?.toLowerCase()], enabled: !!nativeBinding(engine) && block !== undefined,
    queryFn: () => readNative(engine, owner, block!), refetchInterval: 8000 });
}

export function useResolutionEvents(engine: Address) {
  return useQuery({ queryKey: ["resolution-events", engine.toLowerCase()], refetchInterval: 15000, retry: 2,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/resolution-events/${engine}`, { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Resolution history unavailable.");
      return (await response.json()) as { through: number; events: ResolutionEvent[] };
    } });
}
