/** One-time pricing activation readiness. Reads only; the engine rechecks every condition. */
export const ACTIVATION_RECHECK_MS = 2_000;

/** Engines with index warm-up and activatePricing() answer warmupIndex(); older ones revert. */
export async function readFastStartupSupport({ client, engine, abi, blockNumber, transient }) {
  try {
    await client.readContract({ address: engine, abi, functionName: 'warmupIndex', blockNumber });
    return true;
  } catch (error) {
    if (transient(error)) throw error;
    return false;
  }
}

const ready = twap => twap?.available === true && twap.twapWad > 0n;

/** BOOTSTRAP, READY accounting and all three windows complete at this block. */
export function activationDecision({ risk, index, perp, basis }) {
  if (risk.pricingMode !== 0) return { due: false, done: true, reason: 'normal-pricing' };
  if (risk.accountingState !== 0) return { due: false, done: false, reason: 'accounting-not-ready' };
  const windows = { indexSecs: index.coveredSecs, perpSecs: perp.coveredSecs, basisSecs: basis.coveredSecs };
  if (!risk.indexAvailable || !ready(index)) return { due: false, done: false, reason: 'index-window', ...windows };
  if (!ready(perp)) return { due: false, done: false, reason: 'perp-window', ...windows };
  if (basis?.available !== true) return { due: false, done: false, reason: 'basis-window', ...windows };
  return { due: true, done: false, reason: 'windows-complete', ...windows };
}

export async function readPricingActivation({ client, engine, abi, block }) {
  const read = (functionName, args = []) => client.readContract({ address: engine, abi, functionName, args,
    blockNumber: block.number });
  const [risk, index, perp, basis] = await Promise.all([
    read('marketRiskView'), read('indexTwap300', [block.timestamp]),
    read('perpTwap60', [block.timestamp]), read('basisTwap900', [block.timestamp]),
  ]);
  return { ...activationDecision({ risk, index, perp, basis }), block: block.number, timestamp: block.timestamp };
}

/** Recheck at once after a finalized sample (the only event that completes PERP/BASIS). */
export class ActivationSchedule {
  constructor({ enabled, now = Date.now, recheckMs = ACTIVATION_RECHECK_MS }) {
    this.enabled = enabled; this.done = !enabled; this.now = now; this.recheckMs = recheckMs; this.nextAt = 0;
  }
  due() { return !this.done && this.now() >= this.nextAt; }
  sampled() { this.nextAt = 0; }
  waiting() { this.nextAt = this.now() + this.recheckMs; }
  finished() { this.done = true; }
}
