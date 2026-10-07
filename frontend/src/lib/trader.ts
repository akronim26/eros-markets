import { createTraderClient } from "@eros-oracle/oracle-sdk/browser";
import type { Address } from "viem";
import { manifestForEngine } from "@/config/deployment";

export function ownerTrader(engine: Address, owner: Address) {
  const publicManifest = manifestForEngine(engine);
  if (!publicManifest) throw new Error("This market is not in a verified deployment.");
  const market = publicManifest.markets.find((m) => m.engine.toLowerCase() === engine.toLowerCase());
  if (!market) throw new Error("This market is not in the verified deployment.");
  return createTraderClient(publicManifest, market.name, owner);
}
