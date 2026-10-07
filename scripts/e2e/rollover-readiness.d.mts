export const BOOTSTRAP_ROLLOVER_GRACE_SECONDS: bigint;
export const ROLLOVER_INCLUSION_RESERVE_SECONDS: bigint;
export function readBootstrapRolloverDeferral(input: {
  client: {
    getBlock(): Promise<{ number: bigint; timestamp: bigint }>;
    readContract(args: { address: string; abi: unknown; functionName: string; args: bigint[]; blockNumber: bigint }): Promise<any>;
  };
  engine: string;
  abi: unknown;
  scheduledT: bigint;
  pending: boolean;
  knownEpochEnd?: bigint;
  wallTimeMs?: number;
}): Promise<{ defer: boolean; reason: string; block?: bigint; timestamp?: bigint; epochEnd?: bigint;
  deadline?: bigint; indexReady?: boolean; perpReady?: boolean; basisReady?: boolean; carryReady?: boolean }>;
