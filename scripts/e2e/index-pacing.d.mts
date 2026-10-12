export const TESTNET_INDEX_CARRY_SECS: bigint;
export const INDEX_CYCLE_SECS: bigint;
export const FRESH_SOURCE_SECS: bigint;
export const FRESH_UNTIL_SECS: bigint;
export const EARLY_INDEX_MIN_GAP_MS: number;
export const KEEPER_STATUS_MAX_AGE_MS: number;
export const KEEPER_INDEX_MAX_AGE_SECS: bigint;
export function parseEarlyRequest(value: unknown, engine: string): { capturedAt: bigint } | null;
export class IndexPacing {
  constructor(options: { engine: string; readEarlyRequest?: () => unknown; readKeeperStatus?: () => unknown;
    now?: () => number; cycleSecs?: bigint; earlyMinGapMs?: number });
  finalized(observedAt: bigint): void;
  minimumObservedAt(nowMs: number, freshCutoff: bigint): bigint;
}
