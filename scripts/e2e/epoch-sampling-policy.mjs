/** Preserve a recently sealed book observation before the hourly accounting boundary. */
export const EPOCH_SAMPLE_ACCELERATION_SECONDS = 60n;
export const EPOCH_SAMPLE_ACCELERATION_BLOCKS = 12n;
export const SAMPLE_INCLUSION_RESERVE_SECONDS = 8n;

export class SampleEpochDeferred extends Error {
  constructor(reason, context = {}) {
    super(reason);
    this.name = 'SampleEpochDeferred';
    this.context = context;
  }
}

export function epochSamplingPolicy({ timestamp, epochEnd, cadence, nowMs = Date.now() }) {
  if (typeof timestamp !== 'bigint' || timestamp < 0n || typeof epochEnd !== 'bigint' || epochEnd <= 0n
    || typeof cadence !== 'bigint' || cadence <= 0n || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw Error('INVALID_EPOCH_SAMPLING_POLICY');
  // A slow read must not authorize signing against a deadline already reached
  // by wall time. Taking the later clock only refuses work; it never grants it.
  const wallTime = BigInt(Math.floor(nowMs / 1000));
  const asOf = timestamp > wallTime ? timestamp : wallTime;
  const remaining = epochEnd - asOf;
  const accelerated = remaining <= EPOCH_SAMPLE_ACCELERATION_SECONDS;
  return { admit: remaining > SAMPLE_INCLUSION_RESERVE_SECONDS, epochEnd, asOf, remaining,
    cadence: accelerated && cadence > EPOCH_SAMPLE_ACCELERATION_BLOCKS ? EPOCH_SAMPLE_ACCELERATION_BLOCKS : cadence };
}

/** Fetch the actual epoch at one canonical block; a cache never admits a sample. */
export async function readEpochSamplingPolicy({ client, engine, abi, cadence, block, now = Date.now }) {
  const pinned = block ?? await client.getBlock();
  const epoch = await client.readContract({ address: engine, abi, functionName: 'epoch', blockNumber: pinned.number });
  const canonical = await client.getBlock({ blockNumber: pinned.number });
  if (!pinned.hash || canonical.hash !== pinned.hash) throw new SampleEpochDeferred('SAMPLE_EPOCH_BLOCK_CHANGED');
  return epochSamplingPolicy({ timestamp: pinned.timestamp, epochEnd: epoch[2], cadence, nowMs: now() });
}

/** Called after request preparation and immediately before producing signed bytes. */
export async function requireSampleSigningWindow(options) {
  const policy = await readEpochSamplingPolicy(options);
  if (!policy.admit) throw new SampleEpochDeferred('SAMPLE_EPOCH_CLOSING', policy);
  return policy;
}
