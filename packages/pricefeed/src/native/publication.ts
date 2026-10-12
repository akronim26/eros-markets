import { getAddress } from 'viem';
import { record } from '../book.js';
import type { Destination } from '../config.js';
import type { PacketDomain, PreparedPacket } from '../packet-store.js';
import { observationDigest } from '../wire.js';
import { inspectNativeSnapshot } from './collector.js';
import type { KuruSnapshot } from './kuru.js';
import { nativeRulesHash, parseNativeRules, type NativeRulesManifest } from './rules.js';

/** The engine-side identities a native publisher writes to (subset of the shared Destination). */
export type NativeDestination = Pick<Destination, 'chainId' | 'engineAddress' | 'marketId' | 'sourceId' | 'sourceRulesHash'
  | 'signerAddress' | 'scheduledT'>;

/**
 * Pin a native destination and rules against the engine's immutable listing before publishing
 * (NM-F02/F07). The listing must carry this native source id, signer and rules hash, the same
 * depth rule, T and collateral, and the event rules hash the native manifest committed to.
 */
export function verifyNativeListing(dest: NativeDestination, rulesValue: NativeRulesManifest, listing: Record<string, unknown>): void {
  const rules = parseNativeRules(rulesValue);
  checkBinding(dest, rules);
  const pins: Record<string, string> = { marketId: dest.marketId, indexSourceId: dest.sourceId, indexSigner: dest.signerAddress,
    indexRulesHash: dest.sourceRulesHash, depthNLots: rules.depthNLots, maxSpreadWad: rules.maxSpreadWad,
    scheduledT: dest.scheduledT, token: rules.collateral, rulesHash: rules.erosRulesHash };
  for (const [key, value] of Object.entries(pins))
    if (String(record(listing)[key]).toLowerCase() !== value.toLowerCase()) throw new Error(`LISTING_PIN_MISMATCH_${key}`);
  if (record(listing).fundingEnabled !== false) throw new Error('LISTING_PIN_MISMATCH_fundingEnabled');
}

function checkBinding(dest: NativeDestination, rules: NativeRulesManifest): void {
  if (dest.chainId !== rules.chainId) throw new Error('RULES_CONFIG_MISMATCH_chainId');
  if (dest.marketId.toLowerCase() !== rules.marketId || dest.sourceId.toLowerCase() !== rules.sourceId)
    throw new Error('RULES_CONFIG_MISMATCH_identity');
  if (dest.scheduledT !== rules.scheduledT) throw new Error('RULES_CONFIG_MISMATCH_scheduledT');
  if (nativeRulesHash(rules) !== dest.sourceRulesHash.toLowerCase()) throw new Error('RULES_CONFIG_MISMATCH_rulesHash');
}

/**
 * Build the existing `PreparedPacket` from a native Kuru snapshot (NM-F07), so the unchanged packet
 * store, durable signer, relay and receipt checks publish it. The snapshot is revalidated here at
 * preparation time; only COLLECTING (valid) or INVALID_DEPTH (fresh authentic thin/crossed/wide
 * book) produce a packet. Invalid depth carries zero prices and the observed depth, which the
 * engine records as a no-coverage checkpoint. Anything else throws and nothing is signed.
 */
export function prepareNativeObservation(chainId: 31337n | 10143n, dest: NativeDestination, rulesValue: NativeRulesManifest,
  snap: KuruSnapshot, sequence: bigint, publishedAtMs: bigint, minimumHeadroomMs: bigint, lastSourceMs: bigint | null): PreparedPacket {
  const rules = parseNativeRules(rulesValue);
  if (BigInt(dest.chainId) !== chainId) throw new Error('DEVELOPMENT_CHAIN_ONLY');
  if (minimumHeadroomMs <= 0n || minimumHeadroomMs > 30000n) throw new Error('BAD_PUBLICATION_HEADROOM');
  checkBinding(dest, rules);
  const r = inspectNativeSnapshot(rules, snap, publishedAtMs, lastSourceMs, minimumHeadroomMs);
  if ((r.status !== 'COLLECTING' && r.status !== 'INVALID_DEPTH') || !r.summary || !r.time || !r.evidenceHash)
    throw new Error(`OBSERVATION_UNAVAILABLE:${r.reason}`);
  const valid = r.status === 'COLLECTING', s = r.summary;
  const observation = { marketId: dest.marketId, sourceId: dest.sourceId, sequence, observedAt: r.time.observedAt,
    publishedAt: publishedAtMs / 1000n, priceWad: valid ? s.priceWad! : 0n, impactBidWad: valid ? s.impactBidWad! : 0n,
    impactAskWad: valid ? s.impactAskWad! : 0n, bidDepthLots: s.bidDepthLots, askDepthLots: s.askDepthLots,
    sourceRulesHash: dest.sourceRulesHash };
  const domain: PacketDomain = { chainId, engine: getAddress(dest.engineAddress), marketId: dest.marketId, sourceId: dest.sourceId,
    rulesHash: dest.sourceRulesHash, signer: getAddress(dest.signerAddress) };
  observationDigest(observation, chainId, domain.engine);
  return { domain, observation, sourceMs: r.time.sourceMs, evidenceHash: r.evidenceHash };
}
