/** Bounded physical removal of journal-proven owner orders; cancelAll only invalidates epochs. */
export const MAKER_CLEANUP_SCAN_PAGE = 8;
export const MAKER_CLEANUP_MAX_BATCH = 8;
export const MAKER_CLEANUP_MAX_BATCHES_PER_EPOCH = 4;

/** Caller has verified this exact transaction hash, engine logs and canonical finality. */
export function verifiedMakerQuote(record, events, trader, owner, at) {
  const placed = events.filter(event => event.eventName === 'OrderPlaced' && event.args.trader === trader);
  const order = placed[0]?.args;
  if (placed.length !== 1 || order.tick !== record.tick || order.size <= 0n
    || ((order.flags & 1) !== 0) !== (record.side === 'buy')
    || !Number.isSafeInteger(Number(order.id)) || order.id <= 0
    || record.orderId !== undefined && Number(order.id) !== record.orderId
    || record.trader !== undefined && record.trader !== trader
    || record.owner !== undefined && record.owner.toLowerCase() !== owner.toLowerCase()
    || record.size !== undefined && BigInt(record.size) !== order.size)
    throw Error('MAKER_CLEANUP_RECEIPT_MISMATCH');
  return { ...record, orderId: Number(order.id), trader, owner, size: order.size.toString(), at };
}

export function staleMakerOrder(order, record, { trader, side, epoch, accountEpoch, blockNumber }) {
  if (!order || order.size === 0n || (order.flags & 4) === 0) return false;
  if (order.owner !== trader || record.trader !== trader || record.side !== side
    || ((order.flags & 1) !== 0) !== (side === 'buy') || order.tick !== record.tick)
    throw Error('MAKER_CLEANUP_ORDER_MISMATCH');
  return order.marketEpoch !== epoch || order.accountEpoch !== accountEpoch
    || order.expiryBlock !== 0 && BigInt(order.expiryBlock) < blockNumber;
}

/** Empty cancel results are valid if another transaction already unlinked the same generation. */
export function cleanupReceiptOutcome({ pending, events, orders, trader, owner, at }) {
  const ids = cleanupIds(pending.cancelIds);
  if (events.some(event => event.eventName === 'OrderPlaced' || event.eventName === 'OrderRejected'))
    throw Error('MAKER_CLEANUP_UNEXPECTED_PLACEMENT');
  const cancelled = events.filter(event => event.eventName === 'OrderCancelled');
  const removedIds = cancelled.map(event => Number(event.args.id));
  if (new Set(removedIds).size !== removedIds.length
    || cancelled.some(event => !ids.includes(Number(event.args.id)) || event.args.reason !== 0 || event.args.size <= 0n))
    throw Error('MAKER_CLEANUP_CANCEL_MISMATCH');
  if (orders.length !== ids.length || orders.some(order => order.size !== 0n || (order.flags & 4) !== 0))
    throw Error('MAKER_CLEANUP_STILL_LIVE');
  return { hash: pending.hash, side: pending.side, epoch: pending.epoch, cancelIds: ids, removedIds, trader, owner, at };
}

export function cleanupIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAKER_CLEANUP_MAX_BATCH
    || new Set(value).size !== value.length || value.some(id => !Number.isInteger(id) || id < 1 || id > 0xffff_ffff))
    throw Error('MAKER_CLEANUP_IDS_INVALID');
  return value;
}

export function verifyCleanupCalldata(pending, decoded) {
  const ids = cleanupIds(pending.cancelIds);
  if (pending.functionName !== 'batch' || decoded.functionName !== 'batch'
    || decoded.args?.length !== 2 || decoded.args[1].length !== 0
    || decoded.args[0].length !== ids.length || decoded.args[0].some((id, i) => Number(id) !== ids[i]))
    throw Error('MAKER_CLEANUP_CALLDATA_MISMATCH');
}
