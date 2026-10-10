type Twap = { available: boolean; twapWad: bigint; coveredSecs: bigint };
type Risk = { pricingMode: number; accountingState: number; indexAvailable: boolean };
export type ActivationDecision = { due: boolean; done: boolean; reason: string; indexSecs?: bigint; perpSecs?: bigint; basisSecs?: bigint };
export const ACTIVATION_RECHECK_MS: number;
export function readFastStartupSupport(options: { client: unknown; engine: string; abi: unknown; blockNumber?: bigint; transient: (error: unknown) => boolean }): Promise<boolean>;
export function activationDecision(input: { risk: Risk; index: Twap; perp: Twap; basis: Twap }): ActivationDecision;
export function readPricingActivation(options: { client: unknown; engine: string; abi: unknown; block: { number: bigint; timestamp: bigint } }): Promise<ActivationDecision & { block: bigint; timestamp: bigint }>;
export class ActivationSchedule {
  constructor(options: { enabled: boolean; now?: () => number; recheckMs?: number });
  enabled: boolean;
  done: boolean;
  due(): boolean;
  sampled(): void;
  waiting(): void;
  finished(): void;
}
