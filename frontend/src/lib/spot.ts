"use client";
import { useQuery } from "@tanstack/react-query";
import { BaseError, ContractFunctionRevertedError, erc20Abi, type Address } from "viem";
import { KURU_MARGIN, kuruBookAbi, kuruMarginAbi } from "@/abi/kuru";
import { nativeVaultAbi } from "@/abi/nativeVault";
import { nativeBinding } from "@/config/native";
import { client } from "./public-client";
import { ensureNativeTarget } from "./native";
import { decodeL2, type L2 } from "./spot-math";

export type Outcome = "yes" | "no";
export type SpotOrder = { id: number; outcome: Outcome; isBuy: boolean; tick: number; lots: bigint };
type Balances = { usdc: bigint; yes: bigint; no: bigint };
export type SpotSnapshot = {
  block: bigint; issuanceOpen: boolean; resolved: boolean; takerFeeBps: { yes: bigint; no: bigint };
  books: { yes: L2; no: L2 };
  wallet?: Balances; margin?: Balances;
  /** Allowances the UI needs before signing: vault (split), books (wallet-funded market orders), margin (deposits). */
  allowance?: { usdcVault: bigint; usdcYesBook: bigint; usdcNoBook: bigint; yesBook: bigint; noBook: bigint; usdcMargin: bigint; yesMargin: bigint; noMargin: bigint };
  orders?: SpotOrder[];
};

/** Recent order ids scanned per book for the viewer's resting orders (Kuru exposes no per-owner index). */
const ORDER_SCAN = 200;

export async function readSpot(engine: Address, owner: Address | undefined, block: bigint): Promise<SpotSnapshot | undefined> {
  const b = nativeBinding(engine);
  if (!b) return undefined;
  await Promise.all([ensureNativeTarget(b.yesBook), ensureNativeTarget(b.noBook)]);
  const at = { blockNumber: block, allowFailure: false } as const;
  const [issuanceOpen, resolved, yesL2, noL2, yesParams, noParams, yesCounter, noCounter] = await client.multicall({ ...at, contracts: [
    { address: b.vault, abi: nativeVaultAbi, functionName: "issuanceOpen" },
    { address: b.vault, abi: nativeVaultAbi, functionName: "resolved" },
    { address: b.yesBook, abi: kuruBookAbi, functionName: "getL2Book" },
    { address: b.noBook, abi: kuruBookAbi, functionName: "getL2Book" },
    { address: b.yesBook, abi: kuruBookAbi, functionName: "getMarketParams" },
    { address: b.noBook, abi: kuruBookAbi, functionName: "getMarketParams" },
    { address: b.yesBook, abi: kuruBookAbi, functionName: "s_orderIdCounter" },
    { address: b.noBook, abi: kuruBookAbi, functionName: "s_orderIdCounter" },
  ] });
  const snap: SpotSnapshot = { block, issuanceOpen, resolved, takerFeeBps: { yes: yesParams[9], no: noParams[9] },
    books: { yes: decodeL2(yesL2), no: decodeL2(noL2) } };
  if (!owner) return snap;
  const bal = (token: Address) => ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as const;
  const allow = (token: Address, spender: Address) => ({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }) as const;
  const margin = (token: Address) => ({ address: KURU_MARGIN, abi: kuruMarginAbi, functionName: "getBalance", args: [owner, token] }) as const;
  const r = await client.multicall({ ...at, contracts: [
    bal(b.collateral), bal(b.yesToken), bal(b.noToken), margin(b.collateral), margin(b.yesToken), margin(b.noToken),
    allow(b.collateral, b.vault), allow(b.collateral, b.yesBook), allow(b.collateral, b.noBook), allow(b.yesToken, b.yesBook), allow(b.noToken, b.noBook),
    allow(b.collateral, KURU_MARGIN), allow(b.yesToken, KURU_MARGIN), allow(b.noToken, KURU_MARGIN),
  ] });
  snap.wallet = { usdc: r[0], yes: r[1], no: r[2] };
  snap.margin = { usdc: r[3], yes: r[4], no: r[5] };
  snap.allowance = { usdcVault: r[6], usdcYesBook: r[7], usdcNoBook: r[8], yesBook: r[9], noBook: r[10], usdcMargin: r[11], yesMargin: r[12], noMargin: r[13] };
  const ids = (counter: number) => Array.from({ length: Math.min(ORDER_SCAN, counter) }, (_, i) => counter - i);
  const scans = ([["yes", b.yesBook, yesCounter], ["no", b.noBook, noCounter]] as const).map(([outcome, book, counter]) => ({ outcome, book, ids: ids(Number(counter)) }));
  const rows = await client.multicall({ ...at, contracts: scans.flatMap((s) => s.ids.map((id) => ({ address: s.book, abi: kuruBookAbi, functionName: "s_orders", args: [id] }) as const)) });
  const candidates: Array<SpotOrder & { book: Address }> = [];
  let k = 0;
  for (const s of scans) for (const id of s.ids) {
    const o = rows[k++] as readonly [Address, bigint, number, number, number, number, number, boolean];
    if (o[0].toLowerCase() === owner.toLowerCase() && o[1] > 0n) candidates.push({ id, outcome: s.outcome, isBuy: o[7], tick: o[5], lots: o[1], book: s.book });
  }
  // Kuru keeps a filled order's last size in s_orders, so only a simulated cancel shows it is still live.
  const live = await Promise.all(candidates.map(async (c) => {
    try { await client.simulateContract({ address: c.book, abi: kuruBookAbi, functionName: "batchCancelOrders", args: [[c.id]], account: owner, blockNumber: block }); return true; }
    catch (e) {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError && x.data?.errorName === "OrderAlreadyFilledOrCancelled")) return false;
      throw e;
    }
  }));
  snap.orders = candidates.filter((_, i) => live[i]).map(({ book: _book, ...o }) => o);
  return snap;
}

export function useSpot(engine: Address, owner: Address | undefined, block: bigint | undefined) {
  return useQuery({ queryKey: ["spot", engine.toLowerCase(), owner?.toLowerCase()], enabled: !!nativeBinding(engine) && block !== undefined,
    queryFn: () => readSpot(engine, owner, block!), refetchInterval: 8000 });
}
