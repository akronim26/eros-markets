// An expired epoch cannot accept fresh book samples. Only the existing accepted
// sample's original 30-second carry can complete a window during this short wait.
export const BOOTSTRAP_ROLLOVER_GRACE_SECONDS = 20n;
export const ROLLOVER_INCLUSION_RESERVE_SECONDS = 8n;

export async function readBootstrapRolloverDeferral({ client, engine, abi, scheduledT, pending, knownEpochEnd, wallTimeMs = Date.now() }) {
  // Signed journal entries always reconcile, even if a readiness RPC would fail.
  if (pending) return { defer: false, reason: 'pending' };
  // The ordinary operations poll still checks lifecycle work. Avoid duplicating
  // its RPC reads merely to consider deferral before the cached epoch deadline.
  // This cache can only skip a scheduling preference, never authorize work.
  if (knownEpochEnd !== undefined && BigInt(Math.floor(wallTimeMs / 1000)) < knownEpochEnd) {
    return { defer: false, reason: 'epoch-not-due' };
  }
  const block = await client.getBlock();
  const read = (functionName, args = []) => client.readContract({ address: engine, abi,
    functionName, args, blockNumber: block.number });
  const [risk, epoch, work, active] = await Promise.all([
    read('marketRiskView'), read('epoch'), read('work'), read('active'),
  ]);
  const now = block.timestamp, epochEnd = epoch[2];
  // Storage work must still be READY: never defer a sweep already in progress.
  // Virtual accountingState must identify only the expired epoch's rollover.
  // Remain entirely before backing grace, including the inclusion reserve.
  if (!active || risk.pricingMode !== 0 || risk.stage !== 0 || risk.monitorRestricted
    || work !== 0 || risk.accountingState !== 1 || risk.pendingWork !== 2
    || epoch[0] === 0n || now < epochEnd
    || now >= epochEnd + BOOTSTRAP_ROLLOVER_GRACE_SECONDS
    || epochEnd + BOOTSTRAP_ROLLOVER_GRACE_SECONDS + ROLLOVER_INCLUSION_RESERVE_SECONDS >= scheduledT - 45_000n) {
    return { defer: false, reason: 'ordinary-rollover' };
  }
  const [index, perp, basis, carry] = await Promise.all([
    read('indexTwap300', [now]), read('perpTwap60', [now]), read('basisTwap900', [now]),
    read('perpTwap60', [now + ROLLOVER_INCLUSION_RESERVE_SECONDS]),
  ]);
  const indexReady = index.available && index.twapWad > 0n;
  const perpReady = perp.available && perp.twapWad > 0n;
  // A future covered PERP window also excludes a newest invalid checkpoint at
  // exactly now, which the integral ending at now cannot distinguish.
  const carryReady = carry.available && carry.twapWad > 0n;
  const candidatesReady = indexReady && perpReady && basis.available;
  return { defer: !candidatesReady && indexReady && perpReady && carryReady,
    reason: candidatesReady ? 'candidates-ready' : !indexReady || !perpReady || !carryReady ? 'carry-unavailable' : 'bootstrap-window',
    block: block.number, timestamp: now, epochEnd,
    deadline: epochEnd + BOOTSTRAP_ROLLOVER_GRACE_SECONDS,
    indexReady, perpReady, basisReady: basis.available, carryReady };
}
