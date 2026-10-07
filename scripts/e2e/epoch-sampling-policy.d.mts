export const EPOCH_SAMPLE_ACCELERATION_SECONDS: bigint;
export const EPOCH_SAMPLE_ACCELERATION_BLOCKS: bigint;
export const SAMPLE_INCLUSION_RESERVE_SECONDS: bigint;
export type EpochSamplingPolicy = { admit: boolean; epochEnd: bigint; asOf: bigint; remaining: bigint; cadence: bigint };
export class SampleEpochDeferred extends Error { context: Partial<EpochSamplingPolicy>; constructor(reason: string, context?: Partial<EpochSamplingPolicy>); }
export function epochSamplingPolicy(options: { timestamp: bigint; epochEnd: bigint; cadence: bigint; nowMs?: number }): EpochSamplingPolicy;
export function readEpochSamplingPolicy(options: { client: any; engine: string; abi: any; cadence: bigint; block?: any; now?: () => number }): Promise<EpochSamplingPolicy>;
export function requireSampleSigningWindow(options: Parameters<typeof readEpochSamplingPolicy>[0]): Promise<EpochSamplingPolicy>;
