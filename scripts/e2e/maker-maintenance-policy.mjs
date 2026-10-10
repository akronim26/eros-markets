/** Owner-scoped maintenance limits. Contract preview/simulation remain authoritative. */
export function makerPolicy(env = process.env) {
  const integer = (name, fallback, low, high) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < low || Number(value) > high)
      throw Error(`INVALID_${name}`);
    return Number(value);
  };
  const targetLots = BigInt(integer('EROS_MAKER_TARGET_LOTS', 2_000_000, 1, 4_294_967_295));
  const maximumPositionLots = BigInt(integer('EROS_MAKER_MAX_POSITION_LOTS', 4_000_000, 1, 4_294_967_295));
  if (targetLots > maximumPositionLots) throw Error('MAKER_TARGET_EXCEEDS_POSITION_LIMIT');
  return { targetLots, maximumPositionLots,
    maxActionsPerEpoch: integer('EROS_MAKER_MAX_ACTIONS_PER_EPOCH', 12, 1, 100),
    cooldownMs: integer('EROS_MAKER_REQUOTE_COOLDOWN_MS', 30_000, 5000, 300_000),
    repriceTicks: integer('EROS_MAKER_REPRICE_TICKS', 5, 1, 100),
    captureWaitMs: integer('EROS_MAKER_CAPTURE_WAIT_MS', 15_000, 1000, 25_000) };
}

export function makerOrderIsCurrent(order, trader, side, epoch, accountEpoch, block) {
  return !!order && order.owner === trader && order.size > 0n && (order.flags & 4) !== 0
    && ((order.flags & 1) !== 0) === (side === 'buy') && order.marketEpoch === epoch
    && order.accountEpoch === accountEpoch && (order.expiryBlock === 0 || BigInt(order.expiryBlock) >= block);
}

export function makerMaintenance({ side, positionLots, reservedLots, liveLots, tick, liveTick, depthLots,
  requiredDepthLots, actions, lastActionAt = 0, now = Date.now(), policy }) {
  // An untracked order may belong to another authorized use of the same owner.
  // Never cancel it or add overlapping quotes on its behalf.
  if (reservedLots !== liveLots) return { action: 'wait', reason: 'untracked-owner-orders' };
  if (actions >= policy.maxActionsPerEpoch) return { action: 'wait', reason: 'epoch-action-budget' };
  const directionalPosition = side === 'buy' ? positionLots : -positionLots;
  const room = policy.maximumPositionLots - directionalPosition;
  const size = room < policy.targetLots ? room : policy.targetLots;
  if (size < requiredDepthLots) return { action: 'wait', reason: 'position-limit' };
  const empty = liveLots === 0n;
  const insufficient = depthLots < requiredDepthLots;
  const replenish = liveLots * 4n < size * 3n;
  const reprice = !empty && Math.abs(liveTick - tick) >= policy.repriceTicks;
  if (!empty && !insufficient && !replenish && !reprice) return { action: 'none' };
  if (!empty && now - lastActionAt < policy.cooldownMs) return { action: 'wait', reason: 'requote-cooldown' };
  return { action: 'quote', size, repair: empty || insufficient, reason: empty ? 'empty' : insufficient ? 'insufficient-depth' : replenish ? 'replenish' : 'reprice' };
}

/** Quote reference: the INDEX TWAP once valid, else the engine's warm-up INDEX point. */
export function makerQuoteReference(risk, warmup) {
  if (risk?.indexAvailable === true && risk.indexWad > 0n) return { wad: risk.indexWad, warmup: false };
  if (warmup?.available === true && warmup.pointWad > 0n) return { wad: warmup.pointWad, warmup: true };
  return null;
}

/**
 * Before pricing activation, every book change discards the pending capture and restarts the
 * PERP/BASIS windows. Keep a still-eligible quote unchanged; repair empty or thin depth at once,
 * and reprice only when the live tick nears the edge of the exactly backed band.
 */
export function makerBootstrapHold({ pricingMode, decision, liveTick, referenceTick, bandTicks, marginTicks }) {
  if (pricingMode !== 0 || decision.action !== 'quote' || decision.repair) return false;
  if (decision.reason !== 'reprice' && decision.reason !== 'replenish') return false;
  if (!Number.isInteger(bandTicks) || bandTicks <= 0 || !Number.isInteger(marginTicks) || marginTicks < 0) return false;
  return Math.abs(liveTick - referenceTick) + marginTicks < bandTicks;
}

/** Every sample also captures a successor. Wait for promotion, not for no pending capture. */
export function makerCaptureDelay({ repair, requestedAt, initialPerpAt, latestPerpAt, now = Date.now(), maxWaitMs }) {
  if (repair) return 0;
  if (latestPerpAt > initialPerpAt && now - Number(latestPerpAt) * 1000 < 20_000) return 0;
  return Math.max(0, maxWaitMs - (now - requestedAt));
}

/** Only unsigned market-admission races may be retried; owner/identity errors stop. */
export function retryableMakerAdmission(error) {
  const names = ['PostOnlyCrosses', 'OutsideBootstrapBand', 'Stale', 'StaleEpochMutation', 'SnapshotMismatch', 'Rejected', 'RestRejected'];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (names.includes(current.data?.errorName)) return current.data.errorName;
  }
  return null;
}
