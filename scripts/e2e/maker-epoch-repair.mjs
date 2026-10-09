import { cleanupIds, cleanupReceiptOutcome } from './maker-cleanup.mjs';
import { makerReceiptOutcome } from './maker-receipt.mjs';
import { retryableMakerAdmission } from './maker-maintenance-policy.mjs';

/** A failed unsigned replacement may fall back to cancelling the proven stale order. */
export async function simulateEpochRepair(simulate) {
  try {
    const result = await simulate();
    if (!Array.isArray(result.result) || result.result.length !== 1) throw Error('MAKER_REPAIR_SIMULATION_MISMATCH');
    return result.result[0] ? result : null;
  } catch (error) {
    if (retryableMakerAdmission(error)) return null;
    throw error;
  }
}

/** One journal-proven stale order may share an atomic batch with one post-only replacement. */
export function verifyRepairCalldata(pending, decoded) {
  const ids = cleanupIds(pending.cancelIds), places = decoded.args?.[1], order = places?.[0];
  if (ids.length !== 1 || pending.functionName !== 'batch' || decoded.functionName !== 'batch'
    || decoded.args?.[0]?.length !== 1 || Number(decoded.args[0][0]) !== ids[0]
    || places?.length !== 1 || order.kind !== 2 || order.isBuy !== (pending.side === 'buy')
    || order.reduceOnly !== false || order.tick !== pending.tick || order.size !== BigInt(pending.size)
    || order.maxFills !== 8 || order.expiryBlock !== 0)
    throw Error('MAKER_REPAIR_CALLDATA_MISMATCH');
}

/** A crossing race can cancel successfully without resting a replacement; retain both facts. */
export function repairReceiptOutcome(input) {
  const { events, trader, pending } = input;
  if (events.some(event => ['OrderPlaced', 'OrderRejected'].includes(event.eventName)
    && (event.args.trader !== trader || event.eventName === 'OrderPlaced' && event.args.size !== BigInt(pending.size))))
    throw Error('MAKER_REPAIR_PLACEMENT_MISMATCH');
  const quote = makerReceiptOutcome(input);
  const cleanup = cleanupReceiptOutcome({ ...input,
    events: events.filter(event => !['OrderPlaced', 'OrderRejected'].includes(event.eventName)) });
  return { cleanup, quote };
}

export function makerOwnerOrder(owners, nextSide) {
  const first = owners.findIndex(([side]) => side === nextSide);
  return first > 0 ? [...owners.slice(first), ...owners.slice(0, first)] : owners;
}

export function makerLoopDelay({ pending, progressed }) {
  return pending ? 1000 : progressed ? 0 : 3000;
}
