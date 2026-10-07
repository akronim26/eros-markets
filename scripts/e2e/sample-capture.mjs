/** Read the actual capture event; a successful sample call can be a no-op. */
export async function readCanonicalSampleCapture({ client, engine, event, blockNumber, previous = null }) {
  const empty = { captureVersion: 1, sampledAt: null, sampledBlock: null, sampledBlockHash: null };
  if (blockNumber === undefined) return empty;
  const [block, finalized] = await Promise.all([
    client.getBlock({ blockNumber }), client.getBlock({ blockTag: 'finalized' }),
  ]);
  if (!block.hash || block.number !== blockNumber || finalized.number < blockNumber) throw Error('SAMPLE_CAPTURE_NOT_FINALIZED');
  const logs = await client.getLogs({ address: engine, event, fromBlock: blockNumber, toBlock: blockNumber });
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error('SAMPLE_CAPTURE_NONCANONICAL');
  if (logs.length > 1) throw Error('SAMPLE_CAPTURE_AMBIGUOUS');
  if (logs.length) {
    const log = logs[0];
    if (log.address.toLowerCase() !== engine.toLowerCase() || log.blockNumber !== blockNumber || log.blockHash !== block.hash
      || log.args.observedBlock !== blockNumber || typeof log.args.observedAt !== 'bigint'
      || log.args.observedAt > block.timestamp || log.args.observedAt < 0n) throw Error('SAMPLE_CAPTURE_IDENTITY_MISMATCH');
    return { captureVersion: 1, sampledAt: log.args.observedAt.toString(), sampledBlock: blockNumber.toString(), sampledBlockHash: block.hash };
  }
  // Legacy acknowledgements used receipt time. Do not reinterpret them as a capture.
  if (previous?.captureVersion !== 1 || previous.sampledAt === null) return empty;
  if (previous.engine.toLowerCase() !== engine.toLowerCase() || !/^\d+$/.test(previous.sampledAt)
    || !/^\d+$/.test(previous.sampledBlock) || BigInt(previous.sampledBlock) >= blockNumber) throw Error('SAMPLE_CAPTURE_ACK_MISMATCH');
  const retained = await readCanonicalSampleCapture({ client, engine, event, blockNumber: BigInt(previous.sampledBlock) });
  if (retained.sampledAt !== previous.sampledAt || retained.sampledBlockHash !== previous.sampledBlockHash) throw Error('SAMPLE_CAPTURE_ACK_MISMATCH');
  return retained;
}
