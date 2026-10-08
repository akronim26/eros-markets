import { isAddress, type Address, type Hex } from "viem";
import { client } from "./public-client";
import { marketRegistryAbi } from "@/abi/marketRegistry";
import { deployment, manifestForEngine, marketByEngine, markets, oracleMarkets, type MarketManifest } from "@/config/deployment";
import { INDEXER_URL, indexerQuery } from "./history";
import { canonicalRead, deploymentCacheKey, ensureDeployment } from "./deployment-check";
import { resolveOracleBinding } from "./oracle-binding";
import { createCollateralMetadataReader } from "./collateral-metadata";

class UnsupportedMarket extends Error {}

const readCollateralMetadata = createCollateralMetadataReader({
  client, verify: ensureDeployment, cacheKey: deploymentCacheKey,
  expected: engine => {
    const manifest = manifestForEngine(engine);
    if (!manifest) throw new UnsupportedMarket("Market is not in a verified deployment.");
    const token = manifest.contracts.CollateralToken.address;
    return { vault: manifest.contracts.CollateralVault.address, token, decimals: deployment.risk.collateralDecimals,
      fallbackSymbol: token.toLowerCase() === deployment.risk.collateralToken.toLowerCase() ? deployment.risk.collateralSymbol : "Collateral" };
  },
});
export async function readAssets(engine: Address, block: bigint) {
  return readCollateralMetadata(engine, block);
}

/** Only the verified manifest can enable a terminal and its owner transaction builders. */
export async function resolveMarket(engine: string): Promise<MarketManifest | undefined> {
  return isAddress(engine) ? marketByEngine(engine) : undefined;
}

export async function readIndexedMarketIds(query: typeof indexerQuery = indexerQuery): Promise<Hex[]> {
  const ids = new Set<Hex>();
  for (let offset = 0; offset < 100000;) {
    const limit = Math.min(1000, 100000 - offset);
    const r = await query<{ Market: { id: Hex }[] }>("query($offset:Int!,$limit:Int!){Market(order_by:{id:asc},limit:$limit,offset:$offset){id}}", { offset, limit });
    if (r.Market.length > limit) throw new Error("Market discovery exceeded the requested page size.");
    if (r.Market.length === 0) return [...ids];
    r.Market.forEach((m) => ids.add(m.id));
    offset += r.Market.length;
  }
  throw new Error("Market discovery exceeded the pagination limit.");
}

export async function discoverMarkets() {
  await ensureDeployment();
  const ids = new Set<Hex>(oracleMarkets.map((m) => m.id));
  let indexed = false;
  if (INDEXER_URL) {
    (await readIndexedMarketIds()).forEach((id) => ids.add(id));
    indexed = true;
  }
  const block = (await client.getBlock({ blockTag: "finalized" })).number;
  const records = [
    // Archived identities remain discoverable from reviewed local manifests;
    // their contracts are verified only when their market/account is opened.
    ...markets.filter(m => !m.archived && m.oracleMarketId).map(m => ({ id: m.oracleMarketId!, engine: m.engine as string | undefined })),
    ...[...ids].filter(id => !markets.some(m => m.oracleMarketId === id)).map(id => ({ id, engine: undefined })),
  ];
  const results = await canonicalRead(block, () => Promise.all(records.map(async ({ id, engine }) => {
    const binding = resolveOracleBinding(id, engine);
    const core = await client.readContract({ address: binding.marketRegistry, abi: marketRegistryAbi, functionName: "getMarketCore", args: [id], blockNumber: block });
    if (binding.engine && core.engine.toLowerCase() !== binding.engine.toLowerCase()) throw new UnsupportedMarket("Registry record does not match the verified engine.");
    return resolveMarket(core.engine);
  })));
  const merged = new Map(markets.map((m) => [m.engine.toLowerCase(), m]));
  results.forEach((m) => { if (m) merged.set(m.engine.toLowerCase(), m); });
  return { markets: [...merged.values()], oracleIds: [...ids], indexed, block };
}
