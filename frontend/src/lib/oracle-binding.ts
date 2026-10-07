import type { Address, Hex } from "viem";
import { deploymentManifests } from "@/config/deployment";
import { PublicError } from "./public-error";

type OracleManifest = {
  contracts: Readonly<Record<string, { address: Address }>>;
  markets: readonly { marketId: Hex; engine: Address }[];
};
export type OracleBinding = { marketRegistry: Address; resolutionOracle: Address; engine?: Address };

/** Archived engines keep their own registry/oracle even after a complete redeployment. */
export function resolveOracleBinding(id: Hex, engine?: string, manifests: readonly OracleManifest[] = deploymentManifests): OracleBinding {
  const matches = manifests.flatMap(manifest => manifest.markets
    .filter(m => m.marketId.toLowerCase() === id.toLowerCase() && (!engine || m.engine.toLowerCase() === engine.toLowerCase()))
    .map(m => ({ marketRegistry: manifest.contracts.MarketRegistry.address, resolutionOracle: manifest.contracts.ResolutionOracle.address, engine: m.engine })));
  if (engine && !matches.length) throw new PublicError("Market does not belong to this verified engine.");
  const identities = new Set(matches.map(m => `${m.marketRegistry.toLowerCase()}:${m.resolutionOracle.toLowerCase()}:${m.engine.toLowerCase()}`));
  if (identities.size > 1) throw new PublicError("Select the engine for this market's deployment.");
  if (matches.length) return matches[0];
  // Indexer-only records belong to the currently selected registry. They do not
  // grant an unverified engine access to the trading terminal.
  const current = manifests[0];
  if (!current) throw new PublicError("Oracle deployment is unavailable.");
  return { marketRegistry: current.contracts.MarketRegistry.address, resolutionOracle: current.contracts.ResolutionOracle.address };
}
