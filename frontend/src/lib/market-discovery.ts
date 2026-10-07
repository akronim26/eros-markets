import { isAddress, parseAbi, type Address, type Hex } from "viem";
import { client } from "./public-client";
import { engineAbi } from "@/abi/engine";
import { marketRegistryAbi } from "@/abi/marketRegistry";
import { deployment, marketByEngine, markets, oracleMarkets, type MarketManifest } from "@/config/deployment";
import { INDEXER_URL, indexerQuery } from "./history";
import { canonicalRead, ensureDeployment } from "./deployment-check";
import { resolveOracleBinding } from "./oracle-binding";

class UnsupportedMarket extends Error {}

const metadataAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function token() view returns (address)"]);
export async function readAssets(engine: Address, block: bigint) {
  const [vault, listing] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
    { address: engine, abi: engineAbi, functionName: "collateralVault" },
    { address: engine, abi: engineAbi, functionName: "listing" },
  ] });
  const [token, decimals] = await client.multicall({ blockNumber: block, allowFailure: false, contracts: [
    { address: vault, abi: metadataAbi, functionName: "token" },
    { address: listing.token, abi: metadataAbi, functionName: "decimals" },
  ] });
  if (token.toLowerCase() !== listing.token.toLowerCase() || decimals !== 6) throw new UnsupportedMarket("Unsupported collateral configuration.");
  // ERC-20 symbol is optional. A missing display label must not hide balances
  // or disable custody actions for an otherwise verified token and vault.
  const [label] = await client.multicall({ blockNumber: block, allowFailure: true, contracts: [
    { address: token, abi: metadataAbi, functionName: "symbol" },
  ] });
  const symbol = label.status === "success" && label.result ? label.result
    : token.toLowerCase() === deployment.risk.collateralToken.toLowerCase() ? deployment.risk.collateralSymbol : "Collateral";
  return { vault, token, decimals, symbol };
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
    ...markets.filter(m => m.oracleMarketId).map(m => ({ id: m.oracleMarketId!, engine: m.engine as string | undefined })),
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
