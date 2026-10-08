import { PublicError } from "./public-error";
import { keccak256, parseAbi, toBytes, type Abi, type Address, type Hash } from "viem";
import { publicManifest as currentManifest, deploymentManifests } from "@/config/deployment";
import { engineAbi } from "@/abi/engine";
import { client } from "./public-client";

const bindings = parseAbi([
  "function registry() view returns(address)", "function factory() view returns(address)",
  "function oracle() view returns(address)", "function collateralVault() view returns(address)",
  "function token() view returns(address)", "function engineOf(bytes32) view returns(address)",
]);
type Manifest = (typeof deploymentManifests)[number];
type Verification = { promise: Promise<void>; expiresAt: number };
type VerificationState = {
  entries: Map<string, Verification>;
  generation: number;
  network?: Promise<void>;
  running: number;
  waiting: Array<() => void>;
};
const states = new WeakMap<object, VerificationState>();
const TTL_MS = 300000;
// Bound simultaneous verifier requests across different deployments, leaving
// head/balance reads room under the public proxy's six-request limit.
const MAX_REQUESTS = 4;

function stateForClient(): VerificationState {
  let state = states.get(client);
  if (!state) {
    state = { entries: new Map(), generation: 0, running: 0, waiting: [] };
    states.set(client, state);
  }
  return state;
}

async function limited<T>(read: () => Promise<T>): Promise<T> {
  const state = stateForClient();
  if (state.running >= MAX_REQUESTS) await new Promise<void>((resolve) => state.waiting.push(resolve));
  else state.running++;
  try { return await read(); }
  finally {
    const next = state.waiting.shift();
    if (next) next(); // Transfer this slot directly to its next waiter.
    else state.running--;
  }
}

function invalidate(state: VerificationState) {
  state.generation++;
  state.entries.clear();
}

function selectedManifest(target?: string): Manifest {
  if (target === undefined) return currentManifest;
  const address = target.toLowerCase();
  // Engine identity is unambiguous. Shared infrastructure belongs to the first
  // reviewed manifest using it (current first); callers with an engine use it.
  const manifest = deploymentManifests.find((m) => m.markets.some((market) => market.engine.toLowerCase() === address))
    ?? deploymentManifests.find((m) => Object.values(m.contracts).some((contract) => contract.address.toLowerCase() === address));
  if (!manifest) throw new PublicError("Contract is not part of a reviewed deployment.");
  return manifest;
}

function manifestCacheKey(manifest: Manifest): string {
  // Include every expectation used below: changed reviewed pins never inherit a
  // previous result. The key is an identity only, never evidence of verification.
  const fingerprint = keccak256(toBytes(JSON.stringify({
    chainId: manifest.chainId,
    verifiedAt: manifest.verifiedAt,
    current: manifest === currentManifest,
    contracts: Object.entries(manifest.contracts).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [name, value.address.toLowerCase(), value.codehash.toLowerCase()]),
    markets: manifest.markets.map((m) => [m.engine.toLowerCase(), m.codehash.toLowerCase(), m.marketId, m.sourceId, m.listingHash])
      .sort(([a], [b]) => a.localeCompare(b)),
  })));
  return `${client.uid}:${manifest.chainId}:${fingerprint}`;
}

/** Stable in-memory identity for metadata caches scoped to this client and reviewed deployment. */
export function deploymentCacheKey(target: string): string {
  return manifestCacheKey(selectedManifest(target));
}

/** Chain-only gate for public head reads; unrelated contracts cannot delay the head. */
export function ensureNetwork(): Promise<void> {
  const state = stateForClient();
  if (state.network) return state.network;
  const check = limited(() => client.getChainId()).then((chainId) => {
    if (chainId !== currentManifest.chainId) throw new PublicError("RPC network does not match this deployment.");
  }).catch((error) => {
    invalidate(state);
    throw error;
  }).finally(() => {
    if (state.network === check) state.network = undefined;
  });
  state.network = check;
  return check;
}

/** Fail closed on an RPC pointing to another chain/deployment; never trust addresses alone. */
export async function ensureDeployment(target?: string): Promise<void> {
  const manifest = selectedManifest(target);
  const key = manifestCacheKey(manifest);
  await ensureNetwork();
  const state = stateForClient();
  const existing = state.entries.get(key);
  if (existing && Date.now() < existing.expiresAt) return existing.promise;
  const generation = state.generation;
  const entry: Verification = { promise: Promise.resolve(), expiresAt: Infinity };
  entry.promise = verify(manifest).then(() => {
    if (state.generation !== generation) throw new PublicError("Deployment verification was invalidated; retry.");
    entry.expiresAt = Date.now() + TTL_MS;
  }).catch((error) => {
    if (state.entries.get(key) === entry) state.entries.delete(key);
    throw error;
  });
  state.entries.set(key, entry);
  return entry.promise;
}

async function verify(manifest: Manifest) {
  const [anchor, evidence] = await Promise.all([
    limited(() => client.getBlock({ blockTag: "finalized" })),
    limited(() => client.getBlock({ blockNumber: BigInt(manifest.verifiedAt.blockNumber) })),
  ]);
  if (evidence.hash !== manifest.verifiedAt.blockHash) throw new PublicError("Deployment verification block is not canonical.");
  const c = manifest.contracts;
  const contracts = [...Object.values(c), ...manifest.markets.map((m) => ({ address: m.engine, codehash: m.codehash }))];
  const unique = [...new Map(contracts.map((v) => [v.address.toLowerCase(), v])).values()];
  const checks = [
    ...(manifest === currentManifest ? [[c.MarketRegistry.address, "factory", c.MarketFactory.address] as const] : []),
    [c.MarketRegistry.address, "oracle", c.ResolutionOracle.address],
    [c.ResolutionOracle.address, "registry", c.MarketRegistry.address],
    [c.MarketFactory.address, "registry", c.MarketRegistry.address],
    [c.MarketFactory.address, "collateralVault", c.CollateralVault.address],
    [c.CollateralVault.address, "token", c.CollateralToken.address],
  ] as const;
  const identityContracts: Array<{ address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }> =
    checks.map(([address, functionName]) => ({ address, abi: bindings, functionName }));
  for (const m of manifest.markets) identityContracts.push(
    { address: m.engine, abi: engineAbi, functionName: "listing" },
    { address: m.engine, abi: engineAbi, functionName: "listingHash" },
    { address: c.MarketFactory.address, abi: bindings, functionName: "engineOf", args: [m.marketId] },
    { address: m.engine, abi: engineAbi, functionName: "collateralVault" },
  );
  const identityChecks = limited(async () => {
    const results = await client.multicall({
      blockNumber: anchor.number, allowFailure: false, deployless: true, batchSize: 8192,
      contracts: identityContracts,
    });
    for (const [i, [, , expected]] of checks.entries()) {
      if ((results[i] as Address).toLowerCase() !== expected.toLowerCase()) throw new PublicError("Deployment contract bindings do not match.");
    }
    for (const [i, m] of manifest.markets.entries()) {
      const offset = checks.length + i * 4;
      const [listing, listingHash, engine, vault] = results.slice(offset, offset + 4) as [
        { marketId: string; indexSourceId: string; token: Address; registry: Address; resolutionAuthority: Address },
        string, Address, Address,
      ];
      if (listingHash !== m.listingHash || listing.marketId !== m.marketId || listing.indexSourceId !== m.sourceId
        || engine.toLowerCase() !== m.engine.toLowerCase() || listing.token.toLowerCase() !== c.CollateralToken.address.toLowerCase()
        || listing.registry.toLowerCase() !== c.MarketRegistry.address.toLowerCase()
        || listing.resolutionAuthority.toLowerCase() !== c.ResolutionOracle.address.toLowerCase()
        || vault.toLowerCase() !== c.CollateralVault.address.toLowerCase()) throw new PublicError("Market identity does not match the deployment.");
    }
  });
  const codeChecks = unique.map((v) => limited(async () => {
    // EXTCODEHASH in a creation eth_call verifies the same runtime at this block
    // without downloading hundreds of kilobytes of engine/code-store bytecode.
    const { data } = await client.call({ data: `0x73${v.address.slice(2)}3f60005260206000f3`, blockNumber: anchor.number });
    if (data?.toLowerCase() !== v.codehash.toLowerCase()) throw new PublicError("Contract code does not match the verified deployment.");
  }));
  await Promise.all([...codeChecks, identityChecks]);
  if ((await limited(() => client.getBlock({ blockNumber: anchor.number }))).hash !== anchor.hash) {
    invalidate(stateForClient());
    throw new PublicError("Deployment read block changed; retry.");
  }
}

type CanonicalReadAnchor = Awaited<ReturnType<typeof client.getBlock>> & { hash: Hash };

export async function canonicalRead<T>(blockNumber: bigint, read: (anchor: CanonicalReadAnchor) => Promise<T>, expectedHash?: Hash): Promise<T> {
  const anchor = await client.getBlock({ blockNumber });
  if (!anchor.hash || (expectedHash !== undefined && anchor.hash !== expectedHash)) {
    invalidate(stateForClient());
    throw new PublicError("Read block changed; retry.");
  }
  const result = await read({ ...anchor, hash: anchor.hash });
  if ((await client.getBlock({ blockNumber })).hash !== anchor.hash) {
    invalidate(stateForClient());
    throw new PublicError("Read block changed; retry.");
  }
  return result;
}
