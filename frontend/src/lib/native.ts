"use client";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { nativeBinding, nativeBindingForTarget, nativeBindingForVault, type NativeBinding } from "@/config/native";
import { KURU_MARGIN, kuruBookAbi } from "@/abi/kuru";
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

/**
 * Verify a native call target before signing: the vault and its tokens by the reviewed vault binding,
 * each Kuru book by its on-chain market parameters (YES or NO base, the reviewed collateral as quote,
 * the 1000/1000 precisions and 6 decimals the UI's integer units assume), and Kuru's margin account by
 * its documented address having code.
 */
const books = new Map<string, Promise<void>>();
export async function ensureNativeTarget(target: Address): Promise<void> {
  if (target.toLowerCase() === KURU_MARGIN.toLowerCase()) {
    if (!(await client.getCode({ address: KURU_MARGIN }))) throw new PublicError("Kuru margin account is not deployed on this network.");
    return;
  }
  const b = nativeBindingForTarget(target);
  if (!b) throw new PublicError("Contract is not part of a reviewed deployment.");
  await ensureNativeVault(b.vault);
  const side = target.toLowerCase() === b.yesBook.toLowerCase() ? b.yesToken : target.toLowerCase() === b.noBook.toLowerCase() ? b.noToken : undefined;
  if (!side) return;
  const key = target.toLowerCase();
  let check = books.get(key);
  if (!check) {
    check = client.readContract({ address: target, abi: kuruBookAbi, functionName: "getMarketParams" }).then((p) => {
      if (p[2].toLowerCase() !== side.toLowerCase() || p[4].toLowerCase() !== b.collateral.toLowerCase() || p[0] !== 1000 || p[1] !== 1000n
        || p[3] !== 6n || p[5] !== 6n) throw new PublicError("Kuru book does not match the reviewed outcome token and units.");
    });
    check.catch(() => books.delete(key));
    books.set(key, check);
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
