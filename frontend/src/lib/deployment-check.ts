import { PublicError } from "./public-error";
import { parseAbi } from "viem";
import { publicManifest as currentManifest, deploymentManifests } from "@/config/deployment";
import { engineAbi } from "@/abi/engine";
import { client } from "./public-client";

const bindings = parseAbi([
  "function registry() view returns(address)", "function factory() view returns(address)",
  "function oracle() view returns(address)", "function collateralVault() view returns(address)",
  "function token() view returns(address)", "function engineOf(bytes32) view returns(address)",
]);
let verification: Promise<void> | undefined;
let verifiedUntil = 0;

/** Fail closed on an RPC pointing to another chain/deployment; never trust addresses alone. */
export async function ensureDeployment() {
  if (await client.getChainId() !== currentManifest.chainId) throw new PublicError("RPC network does not match this deployment.");
  if (!verification || Date.now() >= verifiedUntil) {
    verification = verify().then(() => { verifiedUntil = Date.now() + 300000; }).catch((error) => {
      verification = undefined; verifiedUntil = 0; throw error;
    });
    // Share the in-flight verification between concurrent reads.
    verifiedUntil = Infinity;
  }
  return verification;
}

async function verify() {
  const anchor = await client.getBlock({ blockTag: "finalized" });
  for (const manifest of deploymentManifests) {
  const evidence = await client.getBlock({ blockNumber: BigInt(manifest.verifiedAt.blockNumber) });
  if (evidence.hash !== manifest.verifiedAt.blockHash) throw new PublicError("Deployment verification block is not canonical.");
  const c = manifest.contracts;
  const contracts = [...Object.values(c), ...manifest.markets.map((m) => ({ address: m.engine, codehash: m.codehash }))];
  const unique = [...new Map(contracts.map((v) => [v.address.toLowerCase(), v])).values()];
  await Promise.all(unique.map(async (v) => {
    // EXTCODEHASH in a creation eth_call verifies the same runtime at this block
    // without downloading hundreds of kilobytes of engine/code-store bytecode.
    const { data } = await client.call({ data: `0x73${v.address.slice(2)}3f60005260206000f3`, blockNumber: anchor.number });
    if (data?.toLowerCase() !== v.codehash.toLowerCase()) throw new PublicError("Contract code does not match the verified deployment.");
  }));
  const checks = [
    ...(manifest === currentManifest ? [[c.MarketRegistry.address, "factory", c.MarketFactory.address] as const] : []),
    [c.MarketRegistry.address, "oracle", c.ResolutionOracle.address],
    [c.ResolutionOracle.address, "registry", c.MarketRegistry.address],
    [c.MarketFactory.address, "registry", c.MarketRegistry.address],
    [c.MarketFactory.address, "collateralVault", c.CollateralVault.address],
    [c.CollateralVault.address, "token", c.CollateralToken.address],
  ] as const;
  await Promise.all(checks.map(async ([address, functionName, expected]) => {
    const value = await client.readContract({ address, abi: bindings, functionName, blockNumber: anchor.number });
    if (value.toLowerCase() !== expected.toLowerCase()) throw new PublicError("Deployment contract bindings do not match.");
  }));
  await Promise.all(manifest.markets.map(async (m) => {
    const [listing, listingHash, engine, vault] = await Promise.all([
      client.readContract({ address: m.engine, abi: engineAbi, functionName: "listing", blockNumber: anchor.number }),
      client.readContract({ address: m.engine, abi: engineAbi, functionName: "listingHash", blockNumber: anchor.number }),
      client.readContract({ address: c.MarketFactory.address, abi: bindings, functionName: "engineOf", args: [m.marketId], blockNumber: anchor.number }),
      client.readContract({ address: m.engine, abi: engineAbi, functionName: "collateralVault", blockNumber: anchor.number }),
    ]);
    if (listingHash !== m.listingHash || listing.marketId !== m.marketId || listing.indexSourceId !== m.sourceId
      || engine.toLowerCase() !== m.engine.toLowerCase() || listing.token.toLowerCase() !== c.CollateralToken.address.toLowerCase()
      || listing.registry.toLowerCase() !== c.MarketRegistry.address.toLowerCase()
      || listing.resolutionAuthority.toLowerCase() !== c.ResolutionOracle.address.toLowerCase()
      || vault.toLowerCase() !== c.CollateralVault.address.toLowerCase()) throw new PublicError("Market identity does not match the deployment.");
  }));
  }
  if ((await client.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw new PublicError("Deployment read block changed; retry.");
}

export async function canonicalRead<T>(blockNumber: bigint, read: () => Promise<T>): Promise<T> {
  const anchor = await client.getBlock({ blockNumber });
  const result = await read();
  if ((await client.getBlock({ blockNumber })).hash !== anchor.hash) throw new PublicError("Read block changed; retry.");
  return result;
}
