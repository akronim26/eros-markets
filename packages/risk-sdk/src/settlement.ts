// Eros Markets risk SDK — settlement read model (B038).
//
// Read-only decoders for the engine's SettlementView / claims status / conversion fence. The
// SDK never holds an authoritative balance: every value here is decoded from a contract view at
// a named block. Payouts are claimable only when the contract reports `claimsEnabled`; oracle
// finality alone never makes anything claimable.

/** Engine-local outcome. Never cast from the oracle's {NONE, YES, NO, INVALID} enum. */
export enum FinalOutcome {
  UNSET = 0,
  NO = 1,
  YES = 2,
  INVALID = 3,
}

export enum ClearingPhase {
  LIVE = 0,
  HALTED = 1,
  PREPARING = 2,
  READY = 3,
  COMPLETE = 4,
}

/** Mirrors `SettlementView` in contracts/src/interfaces/IResolutionIngress.sol. */
export interface SettlementView {
  phase: ClearingPhase;
  halted: boolean;
  finalOutcome: FinalOutcome;
  oracleFinalityAccepted: boolean;
  invalidPriceReady: boolean;
  settlementPriceE18: bigint; // meaningful only when the price is ready
  snapshotId: string;
  snapshotCursor: bigint;
  payoutCursor: bigint;
  accountCount: bigint;
  totalTraderPayoutAtoms: bigint;
  totalDeficitQ: bigint;
  claimsEnabled: boolean;
  accountingComplete: boolean;
  recoveryRequired: boolean;
}

/** Identity of the read: every displayed value must name the block it came from. */
export interface ReadIdentity {
  chainId: number;
  engine: string;
  blockNumber: bigint;
}

/** UI states the spec requires to be distinct (spec §5.4, §8.6). */
export type SettlementStatus =
  | "LIVE"
  | "HALTED_AWAITING_OUTCOME"
  | "ORACLE_FINAL_PRICE_PENDING"
  | "ORACLE_FINAL_PREPARING"
  | "RECOVERY_REQUIRED"
  | "CLAIMABLE"
  | "COMPLETE";

export function decodeSettlementStatus(v: SettlementView): SettlementStatus {
  if (!v.halted) return "LIVE";
  if (v.claimsEnabled) return v.phase === ClearingPhase.COMPLETE ? "COMPLETE" : "CLAIMABLE";
  if (!v.oracleFinalityAccepted || v.finalOutcome === FinalOutcome.UNSET) return "HALTED_AWAITING_OUTCOME";
  if (v.recoveryRequired) return "RECOVERY_REQUIRED";
  if (v.finalOutcome === FinalOutcome.INVALID && !v.invalidPriceReady) return "ORACLE_FINAL_PRICE_PENDING";
  return "ORACLE_FINAL_PREPARING";
}

/** The only gate for payout buttons. */
export function isClaimable(v: SettlementView): boolean {
  return v.halted && v.claimsEnabled && !v.recoveryRequired;
}

/** Settlement price, or `undefined` while pending. An unknown price is never 0. */
export function settlementPrice(v: SettlementView): bigint | undefined {
  if (v.finalOutcome === FinalOutcome.YES) return 10n ** 18n;
  if (v.finalOutcome === FinalOutcome.NO) return 0n;
  if (v.finalOutcome === FinalOutcome.INVALID && v.invalidPriceReady) return v.settlementPriceE18;
  return undefined;
}

export const STATUS_TEXT: Record<SettlementStatus, string> = {
  LIVE: "trading",
  HALTED_AWAITING_OUTCOME: "halted, awaiting outcome",
  ORACLE_FINAL_PRICE_PENDING: "INVALID final, waiting for scheduled TWAP window",
  ORACLE_FINAL_PREPARING: "outcome final, preparing balances",
  RECOVERY_REQUIRED: "preparation failed: recovery required, claims disabled",
  CLAIMABLE: "claims ready",
  COMPLETE: "all claims paid",
};

/** Conversion fence reasons (contracts/src/settlement/ConversionGate.sol). */
export enum ConversionReason {
  ELIGIBLE = 0,
  DISABLED = 1,
  SNAPSHOT_INCOMPLETE = 2,
  CASH_CLAIM_STARTED = 3,
  UNDERBACKED = 4,
  MODE_SELECTED = 5,
}

export enum ClaimMode {
  UNSELECTED = 0,
  CASH = 1,
  CONVERSION = 2,
}

/** Token conversion may be offered only when the contract itself reports eligibility. */
export function conversionOffered(reason: ConversionReason, mode: ClaimMode): boolean {
  return reason === ConversionReason.ELIGIBLE && mode === ClaimMode.UNSELECTED;
}

/** Whole atoms -> USDC string with 6 decimals (display only). */
export function formatAtoms(atoms: bigint): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
