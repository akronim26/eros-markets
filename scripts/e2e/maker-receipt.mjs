/** Called only after exact transaction hash, engine logs and canonical finality checks. */
export function makerReceiptOutcome({ pending, events, trader, owner, at }) {
  const placed = events.filter(e => e.eventName === 'OrderPlaced' && e.args.trader === trader);
  if (placed.length > 1 || placed.some(e => e.args.tick !== pending.tick
    || ((e.args.flags & 1) !== 0) !== (pending.side === 'buy') || e.args.size <= 0n
    || pending.size !== undefined && e.args.size > BigInt(pending.size))) throw Error('MAKER_ORDER_EVENT_MISMATCH');
  if (!placed.length) {
    const rejected = events.find(e => e.eventName === 'OrderRejected' && e.args.trader === trader);
    // A cancel-and-replace may lose its post-only slot to a concurrent trade.
    if (!rejected && pending.functionName !== 'batch') throw Error('MAKER_ORDER_EVENT_MISSING');
    return { kind: 'rejected', record: { hash: pending.hash, side: pending.side, epoch: pending.epoch, at,
      reason: rejected ? Number(rejected.args.reason) : 'post-only-skipped' } };
  }
  const order = placed[0].args;
  return { kind: 'completed', record: { side: pending.side, epoch: pending.epoch, hash: pending.hash,
    tick: pending.tick, orderId: Number(order.id), trader, size: order.size.toString(), owner, at } };
}
