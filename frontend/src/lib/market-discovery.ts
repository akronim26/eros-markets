import { isAddress, parseAbi, type Address, type Hex } from "viem";
import { client } from "./public-client";
import { engineAbi } from "@/abi/engine";
import { marketRegistryAbi } from "@/abi/marketRegistry";
import { deployment, marketByEngine, markets, oracleMarkets, type MarketManifest } from "@/config/deployment";
import { INDEXER_URL, indexerQuery } from "./history";
import { canonicalRead, ensureDeployment } from "./deployment-check";

class UnsupportedMarket extends Error {}

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
  if (token.toLowerCase() !== listing.token.toLowerCase() || decimals !== 6) throw new UnsupportedMarket("Unsupported collateral configuration.");
  return { vault, token, decimals, symbol };
}

/** Only the verified manifest can enable a terminal and its owner transaction builders. */
export async function resolveMarket(engine: string): Promise<MarketManifest | undefined> {
  return isAddress(engine) ? marketByEngine(engine) : undefined;
}

export async function discoverMarkets() {
  await ensureDeployment();
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
  const block = (await client.getBlock({ blockTag: "finalized" })).number;
  const results = await canonicalRead(block, () => Promise.all([...ids].map(async (id) => {
    const core = await client.readContract({ address: deployment.oracle.marketRegistry, abi: marketRegistryAbi, functionName: "getMarketCore", args: [id], blockNumber: block });
    return resolveMarket(core.engine);
  })));
  const merged = new Map(markets.map((m) => [m.engine.toLowerCase(), m]));
  results.forEach((m) => { if (m) merged.set(m.engine.toLowerCase(), m); });
  return { markets: [...merged.values()], oracleIds: [...ids], indexed, block };
}
