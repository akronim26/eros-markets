/** A short-lived scheduling hint, never an order or signing authorization. */
export const MAKER_PAIR_AFTER_RECEIPT_MS = 10_000;
export const MAKER_PAIR_AFTER_SIGNING_MS = 15_000;

export function makerPairContext({ engine, epoch, risk, sourceId, source }) {
  return JSON.stringify([engine.toLowerCase(), epoch.toString(), risk.riskVersion.toString(),
    risk.profileHash.toLowerCase(), risk.pricingMode, risk.stage, sourceId.toLowerCase(),
    source.signer.toLowerCase(), source.rulesHash.toLowerCase()]);
}

/** One opposite-owner reprice may share the first owner's completed capture wait.
 * It is deliberately memory-only: a restart retains the durable raw transaction
 * but loses this optional optimization and resumes ordinary capture protection.
 */
export class MakerPairedMaintenance {
  candidate = null;
  grant = null;

  clear() { this.candidate = null; this.grant = null; }

  canUse({ side, context, sequence, observedAt, now = Date.now() }) {
    const g = this.grant;
    return !!g && side === g.side && context === g.context && now >= g.receiptAt && now < g.expiresAt
      && sequence >= g.sequence && observedAt >= g.observedAt;
  }

  consume(input) {
    if (!this.canUse(input)) return false;
    this.grant = null;
    return true;
  }

  signed({ hash, side, context, sequence, observedAt, eligible, paired, now = Date.now() }) {
    this.clear();
    if (eligible && !paired) this.candidate = { hash, side, context, sequence, observedAt, signedAt: now };
  }

  finalized({ hash, side, accepted, receiptAt, now = Date.now() }) {
    const c = this.candidate;
    this.candidate = null;
    if (!c || c.hash !== hash || c.side !== side || !accepted || receiptAt > now) return;
    const expiresAt = Math.min(receiptAt + MAKER_PAIR_AFTER_RECEIPT_MS, c.signedAt + MAKER_PAIR_AFTER_SIGNING_MS);
    if (now >= expiresAt) return;
    this.grant = { ...c, side: side === 'buy' ? 'sell' : 'buy', receiptAt, expiresAt };
  }
}
