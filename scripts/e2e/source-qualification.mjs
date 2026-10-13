/** Finite vendor-source eligibility only; this does not simulate signing or chain inclusion. */
export const QUALIFICATION_DURATION_MS = 900_000;
export const QUALIFICATION_STARTUP_ALLOWANCE_MS = 30_000;
const TTL_MS = 30_000;
// Paced Monad testnet INDEX (120 s carry, publish due 80 s after the last observation): a source
// that advances at least every 30 s yields a publishable update by about due + 12 s, so the
// observation lands about 25 s before the carry ends. See index-pacing.mjs.
export const PACED_TESTNET_SOURCE_GAP_MS = 30_000;
const digest = value => typeof value === 'string' && /^(?:0x)?[a-f\d]{64}$/i.test(value)
  ? value.replace(/^0x/i, '').toLowerCase() : null;

export class SourceQualification {
  constructor({ startedAtMs, externalRulesDigest, minimumHeadroomMs, pacedTestnet = false }) {
    if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !digest(externalRulesDigest)
      || !Number.isSafeInteger(minimumHeadroomMs) || minimumHeadroomMs < 0 || minimumHeadroomMs >= TTL_MS
      || typeof pacedTestnet !== 'boolean')
      throw Error('INVALID_SOURCE_QUALIFICATION_CONFIG');
    this.startedAtMs = startedAtMs;
    this.expectedDigest = digest(externalRulesDigest);
    // Default: every source gap must fit the 30 s TTL minus signing headroom.
    this.maxSourceGapMs = pacedTestnet ? PACED_TESTNET_SOURCE_GAP_MS : TTL_MS - minimumHeadroomMs;
    this.pacedTestnet = pacedTestnet;
    this.count = this.validPolls = this.rejectedFuturePolls = this.unsignablePolls = this.failures = 0;
    this.maxAgeMs = this.maxCarryMs = this.maxCaptureGapMs = this.maxAdvanceGapMs = 0;
    this.firstValidAtMs = this.lastAtMs = this.lastSourceMs = undefined;
    this.lastClockMs = startedAtMs;
  }

  fail() { this.failures = 1; } // The runner stops on the first failed observation.
  clock(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < this.lastClockMs) {
      this.fail(); throw Error('QUALIFICATION_CLOCK_MOVED_BACKWARDS');
    }
    this.lastClockMs = nowMs;
  }
  carryThrough(nowMs) {
    if (this.lastSourceMs !== undefined)
      this.maxCarryMs = Math.max(this.maxCarryMs, nowMs - Math.floor(this.lastSourceMs / 1000) * 1000);
  }
  durationComplete(nowMs) {
    return this.firstValidAtMs !== undefined && nowMs - this.firstValidAtMs >= QUALIFICATION_DURATION_MS;
  }

  observe(result, nowMs) {
    try {
      this.clock(nowMs); this.count++;
      if (digest(result.baselineRulesDigest) !== this.expectedDigest) throw Error('CANDIDATE_BASELINE_RULES_CHANGED');
      const inspection = result.inspection, time = inspection?.time;
      if (!time || typeof time.sourceMs !== 'bigint' || typeof time.sourceAgeMs !== 'bigint')
        throw Error('SOURCE_NOT_QUALIFIED');
      // The book receipt time is exact; a poll-start/completion clock is not its substitute.
      const at = Number(time.sourceMs + time.sourceAgeMs);
      if (!Number.isSafeInteger(at) || at < this.startedAtMs || at > nowMs
        || (this.lastAtMs !== undefined && at < this.lastAtMs)) throw Error('INVALID_SOURCE_RECEIPT_TIME');
      const rejectedFuture = inspection.status === 'DEGRADED' && inspection.reason === 'STALE_OR_FUTURE_SOURCE_TIME'
        && time.sourceAgeMs < 0n && time.monotone === true && inspection.summary?.valid === true;
      if (rejectedFuture) {
        this.rejectedFuturePolls++;
        this.carryThrough(nowMs);
        if (this.lastSourceMs === undefined || this.maxCarryMs >= this.maxSourceGapMs)
          throw Error('NO_CONTINUOUS_VALID_SOURCE_COVERAGE');
        return; // Never advance the accepted timestamp with rejected future evidence.
      }
      // Paced testnet: a quiet book older than the signing headroom is not publishable, but the
      // publisher only needs a later update within the source-gap bound; carry is still checked.
      const unsignable = this.pacedTestnet && inspection.status === 'DEGRADED' && inspection.reason === 'INSUFFICIENT_HEADROOM'
        && time.fresh === true && time.sourceAgeMs >= 0n && time.monotone === true && inspection.summary?.valid === true
        && this.lastSourceMs !== undefined && Number(time.sourceMs) === this.lastSourceMs;
      if (unsignable) {
        this.unsignablePolls++;
        this.carryThrough(nowMs);
        if (this.maxCarryMs >= this.maxSourceGapMs) throw Error('NO_CONTINUOUS_VALID_SOURCE_COVERAGE');
        return;
      }
      if (inspection.status !== 'COLLECTING' || inspection.summary?.valid !== true
        || time.monotone !== true || time.sourceAgeMs < 0n) throw Error('SOURCE_NOT_QUALIFIED');
      const stamp = Number(time.sourceMs);
      if (!Number.isSafeInteger(stamp) || stamp <= 0 || (this.lastSourceMs !== undefined && stamp < this.lastSourceMs))
        throw Error('INVALID_ACCEPTED_SOURCE_TIME');
      this.validPolls++;
      this.firstValidAtMs ??= at;
      this.maxAgeMs = Math.max(this.maxAgeMs, at - Math.floor(stamp / 1000) * 1000);
      this.carryThrough(at); // Previous accepted observation must bridge to this receipt.
      if (this.lastAtMs !== undefined) this.maxCaptureGapMs = Math.max(this.maxCaptureGapMs, at - this.lastAtMs);
      if (this.lastSourceMs !== undefined) this.maxAdvanceGapMs = Math.max(this.maxAdvanceGapMs, stamp - this.lastSourceMs);
      this.lastAtMs = at; this.lastSourceMs = stamp;
      this.carryThrough(nowMs); // Include processing time after the new book arrived.
      if (this.maxAgeMs >= this.maxSourceGapMs || this.maxCarryMs >= this.maxSourceGapMs)
        throw Error('NO_CONTINUOUS_VALID_SOURCE_COVERAGE');
    } catch (error) { this.fail(); throw error; }
  }

  snapshot(complete, nowMs) {
    this.clock(nowMs);
    this.carryThrough(nowMs); // Include the final sleep and complete report endpoint.
    const coverageDurationMs = this.firstValidAtMs === undefined ? 0 : nowMs - this.firstValidAtMs;
    return {
      scope: 'Finite observed source-carry eligibility; not proof of accepted on-chain publication continuity',
      complete, passed: complete && this.durationComplete(nowMs) && this.validPolls >= 800 && this.failures === 0
        && this.maxAgeMs < this.maxSourceGapMs && this.maxCarryMs < this.maxSourceGapMs,
      startedAt: new Date(this.startedAtMs).toISOString(),
      firstValidAt: this.firstValidAtMs === undefined ? null : new Date(this.firstValidAtMs).toISOString(),
      checkedAt: new Date(nowMs).toISOString(), durationMs: nowMs - this.startedAtMs, coverageDurationMs,
      count: this.count, validPolls: this.validPolls, rejectedFuturePolls: this.rejectedFuturePolls,
      unsignablePolls: this.unsignablePolls, failures: this.failures,
      maxAgeMs: this.maxAgeMs, maxCarryMs: this.maxCarryMs, maxCaptureGapMs: this.maxCaptureGapMs,
      maxAdvanceGapMs: this.maxAdvanceGapMs, maxSourceGapMs: this.maxSourceGapMs, pacedTestnet: this.pacedTestnet,
    };
  }
}
