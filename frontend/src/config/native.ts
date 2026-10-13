import type { Address, Hex } from "viem";
import bindings from "./native-markets.json";

/** Reviewed native-market bindings from oracle/deployments/native/*.json; verified on chain before any vault call. */
export type NativeBinding = {
  slug: string; marketId: Hex; vault: Address; vaultCodehash: Hex; yesToken: Address; noToken: Address;
  yesSymbol: string; noSymbol: string; yesBook: Address; noBook: Address; collateral: Address; scheduledT: number;
  /** A normal prediction market: Kuru spot only, its registry "engine" is a SpotResolutionAnchor (no perp). */
  spotOnly?: boolean;
};
const byEngine = new Map(Object.entries(bindings as Record<string, NativeBinding>).map(([engine, b]) => [engine.toLowerCase(), { ...b, engine: engine as Address }]));
export const nativeBinding = (engine: string) => byEngine.get(engine.toLowerCase());
export const nativeBindingForVault = (vault: string) => [...byEngine.values()].find((b) => b.vault.toLowerCase() === vault.toLowerCase());

/** Native contract a wallet call may target: the vault, its YES/NO tokens or their Kuru books. */
export const nativeBindingForTarget = (target: string) => {
  const t = target.toLowerCase();
  return [...byEngine.values()].find((b) => [b.vault, b.yesToken, b.noToken, b.yesBook, b.noBook].some((a) => a.toLowerCase() === t));
};
