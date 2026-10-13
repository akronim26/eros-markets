import { getAddress, type Hex } from 'viem';
import { summarizeBook } from '../book.js';
import { sourceTime } from '../time.js';
import { snapshotEvidenceHash, toBook, type KuruSnapshot } from './kuru.js';
import { parseNativeRules, type NativeRulesManifest } from './rules.js';

/** Collateral and outcome tokens are six-decimal (NativeOutcomeVault / OutcomeToken). */
const TOKEN_DECIMALS = 6n;

export type NativeInspection = {
  /** COLLECTING: publishable valid observation. INVALID_DEPTH: authentic, fresh, but thin/crossed/wide.
   *  DEGRADED: stale, not advanced or otherwise unpublishable (withhold; let carry expire).
   *  QUARANTINED: identity/unit mismatch (stop and fix configuration). */
  status: 'COLLECTING' | 'INVALID_DEPTH' | 'DEGRADED' | 'QUARANTINED';
  reason: string | null;
  time: ReturnType<typeof sourceTime> | null;
  summary: ReturnType<typeof summarizeBook> | null;
  evidenceHash: Hex | null;
};

/**
 * Validate one pinned-block Kuru YES-book snapshot against the native rules (NM-F03..F06).
 * Source time is the pinned block's timestamp (seconds); a snapshot must advance the source second
 * strictly beyond `lastSourceMs`, so a cached or repeated read never becomes a new observation.
 * NO-book data is never an input here (it is diagnostic only).
 */
export function inspectNativeSnapshot(rulesValue: NativeRulesManifest, snap: KuruSnapshot, receivedAtMs: bigint,
  lastSourceMs: bigint | null, minimumHeadroomMs: bigint): NativeInspection {
  const result: NativeInspection = { status: 'DEGRADED', reason: null, time: null, summary: null, evidenceHash: null };
  try {
    const rules = parseNativeRules(rulesValue);
    const p = snap.params;
    if (snap.chainId !== BigInt(rules.chainId)) throw new Error('CHAIN_IDENTITY_MISMATCH');
    if (getAddress(snap.market) !== rules.kuruOrderBook) throw new Error('BOOK_IDENTITY_MISMATCH');
    if (getAddress(p.baseAsset) !== rules.yesToken || getAddress(p.quoteAsset) !== rules.collateral)
      throw new Error('PAIR_IDENTITY_MISMATCH');
    if (p.baseDecimals !== TOKEN_DECIMALS || p.quoteDecimals !== TOKEN_DECIMALS) throw new Error('DECIMALS_IDENTITY_MISMATCH');
    result.evidenceHash = snapshotEvidenceHash(snap);
    result.time = sourceTime((snap.blockTimestamp * 1000n).toString(), receivedAtMs, lastSourceMs, minimumHeadroomMs);
    if (!result.time.monotone) throw new Error('BACKWARDS_SOURCE_TIME');
    result.summary = summarizeBook(toBook(snap.l2, p), BigInt(rules.depthNLots), BigInt(rules.maxSpreadWad), 'vwap');
    if (BigInt(rules.scheduledT) <= result.time.observedAt) result.reason = 'AT_OR_AFTER_SCHEDULED_T';
    else if (!result.time.advanced) result.reason = 'SOURCE_SECOND_NOT_ADVANCED';
    else if (!result.time.fresh) result.reason = 'STALE_OR_FUTURE_SOURCE_TIME';
    else if (!result.time.hasHeadroom) result.reason = 'INSUFFICIENT_HEADROOM';
    else if (!result.summary.valid) { result.status = 'INVALID_DEPTH'; result.reason = result.summary.reason; }
    else result.status = 'COLLECTING';
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    if (/IDENTITY|BACKWARDS|UNSUPPORTED_PRECISION/.test(result.reason)) result.status = 'QUARANTINED';
  }
  return result;
}
