import { parseAbi, type Address } from "viem";
import { engineAbi } from "@/abi/engine";
import type { client as publicClient } from "./public-client";

const metadataAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function token() view returns (address)"]);
type Assets = { vault: Address; token: Address; decimals: number; symbol: string };
type ExpectedCollateral = { vault: Address; token: Address; decimals: number; fallbackSymbol: string };
type Dependencies = {
  client: Pick<typeof publicClient, "multicall">;
  verify: (engine: Address) => Promise<void>;
  cacheKey: (engine: Address) => string;
  expected: (engine: Address) => ExpectedCollateral;
};

/** One reader owns one client's cache; only immutable, verified metadata is retained. */
export function createCollateralMetadataReader({ client, verify, cacheKey, expected }: Dependencies) {
  const cache = new Map<string, Promise<Assets>>();

  async function read(engine: Address, block: bigint) {
    const collateral = expected(engine);
    // The reviewed manifest supplies addresses so these checks need only one round.
    // Every address is still checked onchain at the caller's pinned block.
    const [vault, listing, token, decimals, label] = await client.multicall({
      blockNumber: block, allowFailure: true, contracts: [
        { address: engine, abi: engineAbi, functionName: "collateralVault" },
        { address: engine, abi: engineAbi, functionName: "listing" },
        { address: collateral.vault, abi: metadataAbi, functionName: "token" },
        { address: collateral.token, abi: metadataAbi, functionName: "decimals" },
        { address: collateral.token, abi: metadataAbi, functionName: "symbol" },
      ],
    });
    if (vault.status !== "success") throw vault.error;
    if (listing.status !== "success") throw listing.error;
    if (token.status !== "success") throw token.error;
    if (decimals.status !== "success") throw decimals.error;
    if (vault.result.toLowerCase() !== collateral.vault.toLowerCase()
      || listing.result.token.toLowerCase() !== collateral.token.toLowerCase()
      || token.result.toLowerCase() !== collateral.token.toLowerCase()
      || decimals.result !== collateral.decimals) throw new Error("Unsupported collateral configuration.");
    const hasSymbol = label.status === "success" && label.result.length > 0;
    return {
      assets: Object.freeze({ vault: vault.result, token: token.result, decimals: decimals.result,
        symbol: hasSymbol ? label.result : collateral.fallbackSymbol }),
      // ERC-20 symbol is optional, but a transient failure must never become permanent.
      cacheable: hasSymbol,
    };
  }

  return async function readAssets(engine: Address, block: bigint): Promise<Assets> {
    const key = `${cacheKey(engine)}:${engine.toLowerCase()}`;
    // Even a populated metadata cache cannot grant trust after verification fails.
    try { await verify(engine); } catch (error) { cache.delete(key); throw error; }
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read(engine, block).then(({ assets, cacheable }) => {
      if (!cacheable && cache.get(key) === pending) cache.delete(key);
      return assets;
    }).catch(error => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  };
}
