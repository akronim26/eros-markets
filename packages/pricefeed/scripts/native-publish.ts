import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, fallback, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decimalWad, json } from '../src/math.js';
import { readKuruSnapshot, type KuruReadClient } from '../src/native/kuru.js';
import { prepareNativeObservation, verifyNativeListing, type NativeDestination } from '../src/native/publication.js';
import { nativeRulesHash, parseNativeRules } from '../src/native/rules.js';
import { INGRESS_ABI, observationDigest } from '../src/wire.js';

/** Engine reads used to pin and monitor the native source (RegistryBookRiskEngine ABI subset). */
const ENGINE_ABI = [
  ...INGRESS_ABI,
  { type: 'function', name: 'observationDigest', stateMutability: 'view', inputs: [{ name: 'obs', type: 'tuple',
    components: INGRESS_ABI[0].inputs[0].components }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'sourceState', stateMutability: 'view', inputs: [{ name: 'sourceId', type: 'bytes32' }], outputs: [{
    type: 'tuple', components: [{ name: 'signer', type: 'address' }, { name: 'rulesHash', type: 'bytes32' },
      { name: 'lastSequence', type: 'uint64' }, { name: 'lastObservedAt', type: 'uint64' }, { name: 'configured', type: 'bool' }] }] },
  { type: 'function', name: 'indexTwap300', stateMutability: 'view', inputs: [{ name: 'end', type: 'uint64' }], outputs: [{
    type: 'tuple', components: [{ name: 'available', type: 'bool' }, { name: 'twapWad', type: 'int256' },
      { name: 'coveredSecs', type: 'uint256' }, { name: 'integral', type: 'int256' }] }] },
] as const;

/**
 * Native INDEX publisher (NM-F08): pinned-block Kuru YES-book snapshot -> revalidated packet ->
 * signature by the listing's indexSigner -> engine.submitObservation. Sequence and last source time
 * come from the engine's own sourceState each round, so a restarted or duplicated process can only
 * fail with DuplicateOrOldSequence; it never signs two different packets for one accepted sequence.
 * Stops (non-zero) on quarantine; withholds on stale/same-second data.
 *   NATIVE_OBSERVER_KEY=0x.. node dist/scripts/native-publish.js <rpc|env> <rules.json> <engine> <rounds> <intervalMs> [finalized|latest]
 *   (`env`: read the RPC URL from NATIVE_RPC so a credential-bearing URL never appears in argv)
 * Optional NATIVE_RPC_FALLBACKS: comma-separated HTTPS read endpoints tried in order when the primary
 * fails. Gas estimation and submission always use the primary (the writer endpoint).
 */
async function main() {
  const [rpcArg, rulesPath, engineArg, roundsArg, intervalArg, tag = 'finalized', ...extra] = process.argv.slice(2);
  // `env` reads the RPC URL from NATIVE_RPC, keeping credential-bearing URLs out of argv.
  const rpc = rpcArg === 'env' ? process.env.NATIVE_RPC : rpcArg;
  const key = process.env.NATIVE_OBSERVER_KEY as Hex | undefined;
  if (!rpc || !rulesPath || !engineArg || !roundsArg || !intervalArg || extra.length || !key || (tag !== 'finalized' && tag !== 'latest'))
    throw new Error('BAD_ARGUMENTS');
  const rules = parseNativeRules(JSON.parse(readFileSync(rulesPath, 'utf8')));
  const chainId = BigInt(rules.chainId);
  if (chainId !== 10143n && chainId !== 31337n) throw new Error('DEVELOPMENT_CHAIN_ONLY');
  const chain = defineChain({ id: Number(chainId), name: 'eros-native', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } } });
  const reads = readFallbacks(rpc, process.env.NATIVE_RPC_FALLBACKS);
  const primary = http(rpc, { retryCount: 1, timeout: 15_000 });
  const pub = createPublicClient({ chain, transport: reads.length
    ? fallback([primary, ...reads.map(url => http(url, { retryCount: 1, timeout: 15_000 }))]) : primary });
  const writer = createPublicClient({ chain, transport: primary });
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ chain, account, transport: http(rpc, { timeout: 15_000 }) });
  const engine = getAddress(engineArg);
  const listing = await pub.readContract({ address: engine, abi: [{ type: 'function', name: 'listing', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'tuple', components: LISTING_COMPONENTS }] }] as const, functionName: 'listing' }) as unknown as Record<string, unknown>;
  const dest: NativeDestination = { chainId: rules.chainId, engineAddress: engine, marketId: rules.marketId, sourceId: rules.sourceId,
    sourceRulesHash: nativeRulesHash(rules), signerAddress: account.address, scheduledT: rules.scheduledT };
  // A perp listed under its own market id may price from another market's YES book: the source still
  // binds that market's vault and event rules, and the perp's own rules hash is the registry's for its id.
  let listingRulesHash: string | undefined;
  const vaultMarketId = await pub.readContract({ address: getAddress(rules.outcomeVault), abi: VAULT_ABI, functionName: 'marketId' });
  if (vaultMarketId.toLowerCase() !== rules.marketId) {
    const vaultRules = await pub.readContract({ address: getAddress(rules.outcomeVault), abi: VAULT_ABI, functionName: 'rulesHash' });
    if (vaultRules.toLowerCase() !== rules.erosRulesHash) throw new Error('INDEX_VAULT_RULES_MISMATCH');
    const core = await pub.readContract({ address: getAddress(String(listing.registry)), abi: REGISTRY_ABI, functionName: 'getMarketCore',
      args: [rules.marketId as Hex] });
    if (getAddress(core.engine) !== engine) throw new Error('PERP_NOT_LISTED_IN_REGISTRY');
    listingRulesHash = core.rulesHash;
  }
  verifyNativeListing(dest, rules, listing, listingRulesHash); // refuses unless the engine pins this source, signer and rules
  const rounds = Number(roundsArg), interval = Number(intervalArg);
  let readFailures = 0;
  for (let i = 0; i < rounds; i++) {
    const state = await pub.readContract({ address: engine, abi: ENGINE_ABI, functionName: 'sourceState', args: [rules.sourceId as Hex] });
    if (!state.configured || getAddress(state.signer) !== account.address) throw new Error('SOURCE_NOT_CONFIGURED_FOR_SIGNER');
    let snap;
    try {
      snap = await readKuruSnapshot(pub as unknown as KuruReadClient, getAddress(rules.kuruOrderBook), tag);
      readFailures = 0;
    } catch (error) {
      // An inconsistent or failed read (replaced block, L2 block mismatch, RPC error) is never signed:
      // withhold this round and retry; stop after repeated failures so the outage is visible.
      const reason = error instanceof Error ? error.message : String(error);
      console.log(json({ round: i, withheld: `READ_FAILED:${reason.slice(0, 120)}` }));
      if (++readFailures >= MAX_READ_FAILURES) throw new Error(`REPEATED_READ_FAILURES:${reason.slice(0, 120)}`);
      await sleep(interval);
      continue;
    }
    const nowMs = BigInt((await pub.getBlock({ blockTag: 'latest' })).timestamp) * 1000n; // chain clock, never ahead of block.timestamp
    let packet;
    try {
      packet = prepareNativeObservation(chainId as 31337n | 10143n, dest, rules, snap, state.lastSequence + 1n, nowMs, 5000n,
        state.lastSequence === 0n ? null : state.lastObservedAt * 1000n);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(json({ round: i, withheld: reason, block: snap.blockNumber }));
      if (/IDENTITY|BACKWARDS|QUARANTINE/.test(reason)) throw error;
      await sleep(interval);
      continue;
    }
    const o = packet.observation;
    const digest = observationDigest(o, chainId, engine);
    const onchain = await pub.readContract({ address: engine, abi: ENGINE_ABI, functionName: 'observationDigest', args: [toTuple(o)] });
    if (onchain !== digest) throw new Error('DIGEST_MISMATCH');
    const signature = await account.sign({ hash: digest });
    // +30% gas margin: keeper/maker transactions change engine state between estimate and inclusion.
    const gas = await writer.estimateContractGas({ address: engine, abi: ENGINE_ABI, functionName: 'submitObservation', args: [toTuple(o), signature], account });
    const hash = await wallet.writeContract({ address: engine, abi: ENGINE_ABI, functionName: 'submitObservation', args: [toTuple(o), signature], gas: gas * 13n / 10n });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`SUBMIT_REVERTED:${hash}`);
    const twap = await pub.readContract({ address: engine, abi: ENGINE_ABI, functionName: 'indexTwap300', args: [BigInt(receipt.blockNumber === undefined ? 0 : (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp)] });
    console.log(json({ round: i, sequence: o.sequence, observedAt: o.observedAt, valid: o.priceWad !== 0n,
      mid: decimalWad(o.priceWad), bid: decimalWad(o.impactBidWad), ask: decimalWad(o.impactAskWad), tx: hash,
      index: { available: twap.available, twap: twap.available ? decimalWad(BigInt(twap.twapWad)) : null, coveredSecs: twap.coveredSecs } }));
    if (i + 1 < rounds) await sleep(interval);
  }
}

const MAX_READ_FAILURES = 5;
function readFallbacks(primary: string, list = ''): string[] {
  const urls = [...new Set(list.split(',').map(v => v.trim()).filter(v => v && v !== primary))];
  for (const value of urls) {
    let url: URL; try { url = new URL(value); } catch { throw new Error('BAD_FALLBACK_RPC_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('FALLBACK_RPC_HTTPS_REQUIRED');
  }
  return urls;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function toTuple(o: ReturnType<typeof prepareNativeObservation>['observation']) {
  return { ...o, marketId: o.marketId as Hex, sourceId: o.sourceId as Hex, sourceRulesHash: o.sourceRulesHash as Hex };
}
const VAULT_ABI = parseAbi(['function marketId() view returns (bytes32)', 'function rulesHash() view returns (bytes32)']);
const REGISTRY_ABI = parseAbi(['function getMarketCore(bytes32) view returns ((address engine, address questionPtr, address rulesPtr, uint64 listedAt, uint64 windowStart, uint64 windowEnd, uint64 tau, bytes32 groupId, bool groupExclusive, bool hasFeed, uint32 l2DeadlineSecs, uint32 voidSecs, uint32 retryWindowSecs, uint32 earlyTtlSecs, address monitor, uint256 oiCapLots, bytes32 rulesHash, bytes32 specHash, bytes32 gateHash))']);

const LISTING_COMPONENTS = [
  { name: 'marketId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'registry', type: 'address' },
  { name: 'resolutionAuthority', type: 'address' }, { name: 'monitor', type: 'address' }, { name: 'governance', type: 'address' },
  { name: 'scheduledT', type: 'uint64' }, { name: 'listedAt', type: 'uint64' }, { name: 'sourceHash', type: 'bytes32' },
  { name: 'rulesHash', type: 'bytes32' }, { name: 'invalidRule', type: 'tuple', components: [{ name: 'fallbackListed', type: 'bool' },
    { name: 'captureGraceSecs', type: 'uint64' }, { name: 'fallbackPriceWad', type: 'uint256' }, { name: 'voidSecs', type: 'uint64' }] },
  { name: 'template', type: 'uint8' }, { name: 'deploymentCapX', type: 'uint256' }, { name: 'maxTraders', type: 'uint32' },
  { name: 'indexSourceId', type: 'bytes32' }, { name: 'indexSigner', type: 'address' }, { name: 'indexRulesHash', type: 'bytes32' },
  { name: 'depthNLots', type: 'uint256' }, { name: 'maxSpreadWad', type: 'uint256' }, { name: 'bootstrapBandWad', type: 'uint256' },
  { name: 'minOrderLots', type: 'uint64' }, { name: 'maxOrderLots', type: 'uint64' }, { name: 'maxLiqLotsPerBlock', type: 'uint64' },
  { name: 'fundingEnabled', type: 'bool' }] as const;

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
