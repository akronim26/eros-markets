import { createTraderClient } from "@eros-oracle/oracle-sdk/browser";
import type { Address } from "viem";
import { publicManifest } from "@/config/deployment";

export function ownerTrader(engine: Address, owner: Address) {
  const market = publicManifest.markets.find((m) => m.engine.toLowerCase() === engine.toLowerCase());
  if (!market) throw new Error("This market is not in the verified deployment.");
  return createTraderClient(publicManifest, market.name, owner);
}
