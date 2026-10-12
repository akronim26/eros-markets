/**
 * Lower-cost testnet INDEX cadence. On Monad testnet an authenticated INDEX observation carries
 * 120 s and a sealed book sample 300 s, so the publisher no longer sends every source update.
 * It publishes once per cycle, timed from the newest finalized observation and preferring a
 * fresh source, plus:
 *  - every source update while MARK is still warming up (keeper reports `markAvailable`);
 *  - one early observation after a book-change capture, so that capture can seal.
 * Pacing only delays publication. Source admission, freshness and signing are unchanged, and a
 * missing or unreadable hint always publishes rather than holds.
 */
export const TESTNET_INDEX_CARRY_SECS = 120n;
export const INDEX_CYCLE_SECS = 70n; // a 30 s window to catch a fresh source, then a late fallback
// A paced publish takes only a fresh source (<= 6 s old: >= 18 s of signing headroom under the
// 30 s source TTL and 5 s reserve) until this long after the last observation, then any source
// within the usual cutoff. On 2026-10-11 a 15 s old source expired during a slow RPC send and
// the nonce recovery that followed lapsed INDEX for 81 s.
export const FRESH_SOURCE_SECS = 6n;
export const FRESH_UNTIL_SECS = 100n;
export const EARLY_INDEX_MIN_GAP_MS = 20_000; // at most one extra cycle per 20 s
export const KEEPER_STATUS_MAX_AGE_MS = 30_000;
// The keeper samples only while INDEX is well inside its carry; inclusion takes a few seconds.
export const KEEPER_INDEX_MAX_AGE_SECS = TESTNET_INDEX_CARRY_SECS - 10n;

const decimal = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);

/** Validate the keeper's early-INDEX request; anything else is ignored. */
export function parseEarlyRequest(value, engine) {
  if (!value || value.engine?.toLowerCase() !== engine.toLowerCase() || !decimal(value.capturedAt)) return null;
  return { capturedAt: BigInt(value.capturedAt) };
}

export class IndexPacing {
  constructor({ engine, readEarlyRequest = () => null, readKeeperStatus = () => null, now = Date.now,
    cycleSecs = INDEX_CYCLE_SECS, earlyMinGapMs = EARLY_INDEX_MIN_GAP_MS } = {}) {
    if (!engine) throw Error('PACING_ENGINE_REQUIRED');
    if (typeof cycleSecs !== 'bigint' || cycleSecs <= 0n || cycleSecs >= FRESH_UNTIL_SECS) throw Error('INVALID_INDEX_CYCLE');
    Object.assign(this, { engine, readEarlyRequest, readKeeperStatus, now, cycleSecs, earlyMinGapMs });
    this.lastFinalizedObservedAt = null; this.lastEarlyAt = -Infinity; this.earlyFor = null;
  }

  /** A finalized observation from this publisher (or its replay after restart). */
  finalized(observedAt) {
    if (typeof observedAt !== 'bigint') throw Error('INVALID_FINALIZED_OBSERVATION');
    if (this.lastFinalizedObservedAt === null || observedAt > this.lastFinalizedObservedAt) this.lastFinalizedObservedAt = observedAt;
  }

  warmingUp(nowMs) {
    let status;
    try { status = this.readKeeperStatus(); } catch { return false; }
    // A stale or absent keeper cannot use extra INDEX points; keep the slow cadence.
    if (!status || status.engine?.toLowerCase() !== this.engine.toLowerCase() || !Number.isSafeInteger(status.at)
      || nowMs - status.at > KEEPER_STATUS_MAX_AGE_MS || status.state !== 'running') return false;
    return status.markAvailable === false;
  }

  earlyRequest(nowMs) {
    let request;
    try { request = parseEarlyRequest(this.readEarlyRequest(), this.engine); } catch { return null; }
    if (!request || (this.lastFinalizedObservedAt !== null && request.capturedAt < this.lastFinalizedObservedAt)) return null;
    if (this.earlyFor === request.capturedAt) return request; // keep the decision until it seals
    if (nowMs - this.lastEarlyAt < this.earlyMinGapMs) return null;
    this.earlyFor = request.capturedAt; this.lastEarlyAt = nowMs;
    return request;
  }

  /**
   * Minimum source `observedAt` (exclusive) the publisher may send now. `freshCutoff` publishes
   * any fresh update; `nowSec` holds publication until the next decision.
   */
  minimumObservedAt(nowMs, freshCutoff) {
    const nowSec = BigInt(Math.floor(nowMs / 1000));
    const early = this.earlyRequest(nowMs);
    if (early) return early.capturedAt > freshCutoff ? early.capturedAt : freshCutoff;
    if (this.lastFinalizedObservedAt === null || this.warmingUp(nowMs)) return freshCutoff;
    if (nowSec < this.lastFinalizedObservedAt + this.cycleSecs) return nowSec;
    if (nowSec < this.lastFinalizedObservedAt + FRESH_UNTIL_SECS) {
      const fresh = nowSec - FRESH_SOURCE_SECS - 1n; // the snapshot must be newer than this
      return fresh > freshCutoff ? fresh : freshCutoff;
    }
    return freshCutoff;
  }
}
