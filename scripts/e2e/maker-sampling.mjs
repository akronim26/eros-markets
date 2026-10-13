/** A finalized, valid PERP event seals a capture; freshness() is an accounting clock. */
export async function makerPerpPromotion({ client, engine, event, blockNumber, previous = 0n }) {
  if (blockNumber === undefined) return previous;
  const [block, finalized] = await Promise.all([
    client.getBlock({ blockNumber }), client.getBlock({ blockTag: 'finalized' }),
  ]);
  if (!block.hash || block.number !== blockNumber || finalized.number < blockNumber)
    throw Error('MAKER_SAMPLE_NOT_FINALIZED');
  const logs = await client.getLogs({ address: engine, event, fromBlock: blockNumber, toBlock: blockNumber });
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error('MAKER_SAMPLE_NONCANONICAL');
  if (logs.length > 1) throw Error('MAKER_SAMPLE_AMBIGUOUS');
  for (const log of logs) {
    if (log.address.toLowerCase() !== engine.toLowerCase() || log.blockNumber !== blockNumber
      || log.blockHash !== block.hash || typeof log.args.t !== 'bigint'
      || log.args.t < 0n || log.args.t > block.timestamp) throw Error('MAKER_SAMPLE_IDENTITY_MISMATCH');
    if (log.args.valid === true && log.args.basisValid === true && log.args.t > previous) previous = log.args.t;
  }
  return previous;
}
