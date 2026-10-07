export function keeperGasCeiling(input?: string): bigint;
export function boundedRolloverHelper<T extends { gasCeiling: number }>(helper: T | undefined, ceiling: bigint): T | undefined;
export class KeeperGasLimitExceeded extends Error {
  gas: bigint | undefined;
  ceiling: bigint;
  constructor(gas: bigint | undefined, ceiling: bigint);
}
export function requireKeeperGas(gas: bigint, ceiling: bigint): void;
export function runKeeperAction<T>(input: {
  run: () => Promise<T>;
  rolloverCeiling?: bigint;
  hasPending: () => boolean;
  onLimit: (error: KeeperGasLimitExceeded) => Promise<void> | void;
}): Promise<{ limited: false; result: T } | { limited: true }>;
