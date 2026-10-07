import type { Address, Hex } from "viem";
import { toPublicManifest } from "@eros-oracle/oracle-sdk/browser";
import verified from "./public-manifest.json";
import archived from "./archived-deployments.json";
import metadata from "./market-metadata.json";

const parsed = toPublicManifest(verified);
if (!parsed.verifiedAt || parsed.chainId !== 10143) throw new Error("Verified Monad testnet deployment required.");
export const publicManifest = { ...parsed, verifiedAt: parsed.verifiedAt };
export const archivedManifests = archived.map(value => {
  const manifest = toPublicManifest(value);
  if (!manifest.verifiedAt || manifest.chainId !== parsed.chainId) throw new Error("Verified archive on the selected chain required.");
  return { ...manifest, verifiedAt: manifest.verifiedAt };
});
export const deploymentManifests = [publicManifest, ...archivedManifests];
export function manifestForEngine(engine: string) {
  return deploymentManifests.find(manifest => manifest.markets.some(m => m.engine.toLowerCase() === engine.toLowerCase()));
}
export const deployment = {
  chainId: publicManifest.chainId,
  risk: {
    collateralVault: publicManifest.contracts.CollateralVault.address,
    collateralToken: publicManifest.contracts.CollateralToken.address,
    collateralDecimals: 6,
    collateralSymbol: "tUSDC",
  },
  oracle: {
    resolutionOracle: publicManifest.contracts.ResolutionOracle.address,
    marketRegistry: publicManifest.contracts.MarketRegistry.address,
    umaAdapter: publicManifest.contracts.UmaAdapter.address,
    bondToken: publicManifest.contracts.CollateralToken.address,
    deployBlock: BigInt(publicManifest.contracts.MarketRegistry.deployBlock),
  },
} as const;

export type MarketManifest = {
  engine: Address; marketId: Hex; listingHash: Hex; deployBlock: bigint;
  title: string; short: string; oracleMarketId: Hex | null;
  resolution: "MANUAL_TEST_AUTHORITY" | "ORACLE"; fixture: boolean;
  role: "demo" | "terminal-test";
  archived?: boolean;
  category?: string; source?: string;
};
export const markets: MarketManifest[] = deploymentManifests.flatMap((manifest, i) => manifest.markets.map((m) => ({
  engine: m.engine, marketId: m.marketId, listingHash: m.listingHash, deployBlock: BigInt(m.deployBlock),
  title: metadata[m.name as keyof typeof metadata].title,
  short: metadata[m.name as keyof typeof metadata].short,
  category: (metadata[m.name as keyof typeof metadata] as { category?: string }).category,
  source: (metadata[m.name as keyof typeof metadata] as { source?: string }).source,
  archived: i > 0 || ((metadata[m.name as keyof typeof metadata] as { archived?: boolean }).archived ?? false),
  oracleMarketId: m.marketId, resolution: "ORACLE", fixture: false, role: "demo",
})));
if (new Set(markets.map(m => m.engine.toLowerCase())).size !== markets.length) throw new Error("Duplicate market deployment.");
export const oracleMarkets = markets.map((m) => ({ id: m.marketId,
  note: "External Polymarket event. Synthetic risk calibration; test collateral and owner-controlled UMA sandbox. CRE simulation mode." }));
export const marketByEngine = (engine: string) => markets.find((m) => m.engine.toLowerCase() === engine.toLowerCase());
