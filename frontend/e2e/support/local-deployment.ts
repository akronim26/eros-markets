/** Replaces the public deployment module only in an explicitly isolated E2E build. */
import type { Address, Hex } from "viem";
import { toPublicManifest } from "@eros-oracle/oracle-sdk/browser";
import selected from "@eros-e2e/manifest";
const parsed = toPublicManifest(selected);
if (parsed.chainId !== 31337 || parsed.scope !== "local-only" || !parsed.verifiedAt) throw new Error("Verified local E2E manifest required");
export const publicManifest = { ...parsed, verifiedAt: parsed.verifiedAt };
export const deploymentManifests = [publicManifest];
export const archivedManifests = [];
export const manifestForEngine = (engine: string) => publicManifest.markets.some(m => m.engine.toLowerCase() === engine.toLowerCase()) ? publicManifest : undefined;
export const deployment = {
  chainId: 31337,
  risk: { collateralVault: parsed.contracts.CollateralVault.address, collateralToken: parsed.contracts.CollateralToken.address, collateralDecimals: 6, collateralSymbol: "TEST" },
  oracle: { resolutionOracle: parsed.contracts.ResolutionOracle.address, marketRegistry: parsed.contracts.MarketRegistry.address,
    umaAdapter: parsed.contracts.MockAssertionVenue.address, bondToken: parsed.contracts.CollateralToken.address, deployBlock: BigInt(parsed.contracts.MarketRegistry.deployBlock) },
} as const;
export type MarketManifest = { engine: Address; marketId: Hex; listingHash: Hex; deployBlock: bigint; title: string; short: string; oracleMarketId: Hex | null;
  resolution: "MANUAL_TEST_AUTHORITY" | "ORACLE"; fixture: boolean; role: "demo" | "terminal-test"; archived?: boolean; category?: string; source?: string };
export const markets: MarketManifest[] = parsed.markets.map(m => ({ engine: m.engine, marketId: m.marketId, listingHash: m.listingHash,
  deployBlock: BigInt(m.deployBlock), title: `Local E2E ${m.name} event`, short: m.name, oracleMarketId: m.marketId, resolution: "ORACLE", fixture: true,
  role: m.name === "terminal" ? "terminal-test" : "demo" }));
export const oracleMarkets = markets.map(m => ({ id: m.marketId, note: "Disposable local E2E fixture: synthetic prices, test tokens and scripted resolution." }));
export const marketByEngine = (address: string) => markets.find(m => m.engine.toLowerCase() === address.toLowerCase());
