import type { Address, Hex } from "viem";
import { toPublicManifest } from "@eros-oracle/oracle-sdk/browser";
import verified from "./public-manifest.json";
import metadata from "./market-metadata.json";

const parsed = toPublicManifest(verified);
if (!parsed.verifiedAt || parsed.chainId !== 10143) throw new Error("Verified Monad testnet deployment required.");
export const publicManifest = { ...parsed, verifiedAt: parsed.verifiedAt };
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
};
export const markets: MarketManifest[] = publicManifest.markets.map((m) => ({
  engine: m.engine, marketId: m.marketId, listingHash: m.listingHash, deployBlock: BigInt(m.deployBlock),
  title: metadata[m.name as keyof typeof metadata].title,
  short: metadata[m.name as keyof typeof metadata].short,
  oracleMarketId: m.marketId, resolution: "ORACLE", fixture: false, role: "demo",
}));
export const oracleMarkets = markets.map((m) => ({ id: m.marketId,
  note: "External Polymarket event. Synthetic risk calibration; test collateral and owner-controlled UMA sandbox. CRE simulation mode." }));
export const marketByEngine = (engine: string) => markets.find((m) => m.engine.toLowerCase() === engine.toLowerCase());
