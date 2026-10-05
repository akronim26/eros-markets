import { isAddress, parseAbi, type Address, type Hex } from "viem";
import { client } from "./public-client";
import { engineAbi } from "@/abi/engine";
import { marketRegistryAbi } from "@/abi/marketRegistry";
import { deployment, marketByEngine, markets, oracleMarkets, type MarketManifest } from "@/config/deployment";
import { INDEXER_URL, indexerQuery } from "./history";

const metadataAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function token() view returns (address)"]);
export async function readAssets(engine: Address, block: bigint) {
  const [vault, listing] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
    { address: engine, abi: engineAbi, functionName: "collateralVault" },
    { address: engine, abi: engineAbi, functionName: "listing" },
  ] });
  const [token, decimals, symbol] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
    { address: vault, abi: metadataAbi, functionName: "token" },
    { address: listing.token, abi: metadataAbi, functionName: "decimals" },
    { address: listing.token, abi: metadataAbi, functionName: "symbol" },
  ] });
  if (token.toLowerCase() !== listing.token.toLowerCase() || decimals !== 6) throw new Error("Unsupported collateral configuration.");
  return { vault, token, decimals, symbol };
}

export async function resolveMarket(engine: string, block?: bigint): Promise<MarketManifest | undefined> {
  const fixture = marketByEngine(engine);
  if (fixture) return fixture;
  if (!isAddress(engine)) return undefined;
  const at = block ?? await client.getBlockNumber();
  try {
    const listing = await client.readContract({ address: engine, abi: engineAbi, functionName: "listing", blockNumber: at });
    const [core, title, listingHash] = await Promise.all([
      client.readContract({ address: deployment.oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getMarketCore", args: [listing.marketId], blockNumber: at }),
      client.readContract({ address: deployment.oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getQuestion", args: [listing.marketId], blockNumber: at }),
      client.readContract({ address: engine, abi: engineAbi, functionName: "listingHash", blockNumber: at }),
    ]);
    if (core.engine.toLowerCase() !== engine.toLowerCase() || listing.registry.toLowerCase() !== deployment.oracle.marketRegistry.toLowerCase()
      || listing.resolutionAuthority.toLowerCase() !== deployment.oracle.resolutionOracle.toLowerCase()) return undefined;
    await readAssets(engine, at);
    return { engine, marketId: listing.marketId, listingHash, deployBlock: deployment.oracle.deployBlock, title,
      short: title.length > 36 ? `${title.slice(0, 33)}…` : title, oracleMarketId: listing.marketId, resolution: "ORACLE", fixture: false, role: "demo" };
  } catch { return undefined; }
}

export async function discoverMarkets() {
  const ids = new Set<Hex>(oracleMarkets.map((m) => m.id));
  let indexed = false;
  if (INDEXER_URL) {
    for (let offset = 0; ; offset += 1000) {
      const r = await indexerQuery<{ Market: { id: Hex }[] }>("query($offset:Int!){Market(order_by:{id:asc},limit:1000,offset:$offset){id}}", { offset });
      r.Market.forEach((m) => ids.add(m.id));
      if (r.Market.length < 1000) break;
      if (offset >= 99000) throw new Error("Market discovery exceeded the pagination limit.");
    }
    indexed = true;
  }
  const block = await client.getBlockNumber();
  const results = await Promise.all([...ids].map(async (id) => {
    const core = await client.readContract({ address: deployment.oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getMarketCore", args: [id], blockNumber: block });
    return resolveMarket(core.engine, block);
  }));
  const merged = new Map(markets.map((m) => [m.engine.toLowerCase(), m]));
  results.forEach((m) => { if (m) merged.set(m.engine.toLowerCase(), m); });
  return { markets: [...merged.values()], oracleIds: [...ids], indexed, block };
}
