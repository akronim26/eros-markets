/** Scheduling only. Fresh reads, simulations and canonical receipts still gate orders.
 * Delays are upper bounds: the maker wakes earlier on publisher/keeper readiness notices. */
export const MAKER_READINESS_BACKOFF_MS = 15_000;
export const MAKER_ROLLOVER_POLL_MS = 1_000;
export function makerReadinessDelay(risk, warmup) {
  // Before the first complete INDEX window, a fresh authenticated INDEX point is a quote
  // reference for funded post-only warm-up quotes (engines that expose warmupIndex()).
  if (risk?.indexAvailable !== true && warmup?.available !== true) return MAKER_READINESS_BACKOFF_MS;
  if (risk.accountingState === 0) return 0; // AccountingState.READY.
  // AccountingState.ROLLOVER_SWEEP and the rollover pending-work bit. A staged
  // epoch-opening profile (bit8) does not delay requoting; floor/halt work does.
  // An expired epoch
  // derives this state even before beginRollover has been included.
  if (risk.accountingState === 1 && (risk.pendingWork === 2 || risk.pendingWork === 10)) return MAKER_ROLLOVER_POLL_MS;
  return MAKER_READINESS_BACKOFF_MS;
}
