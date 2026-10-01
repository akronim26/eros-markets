// Eros Markets risk SDK — read-only risk + settlement read model (B042).
//
// Combines Person A's ledger replay (A032 `accounting.ts`, re-exported below) with B's risk, stage
// and settlement decoders. Every decoded value carries
// the read identity (chain, engine, block, risk version, price and cutoff). Nothing computed here
// is authoritative: the contract views are. Unavailable values are `undefined`, never 0, and
// projections are labelled estimates, never withdrawable amounts.

export * from "./settlement";
export { AccountingReplay, markedEquityQ, unsignedAtoms } from "./accounting";
export type { AccountBalance, MarketBalance, AccountingEvent } from "./accounting";
import { Q } from "./accounting";
export { Q }; // cashQ per USDC atom (one definition, A032)
export const ATOMS_PER_USDC = 1_000_000n;
export const LOTS_PER_CLAIM = 1000n;
export const WAD = 10n ** 18n;

export enum Stage {
  TRADING = 0,
  BACKING_GRACE = 1,
  BACKING_FLOOR = 2,
  REDUCE_ONLY = 3,
  HALTED = 4,
  CLAIMS_READY = 5,
}

export enum PricingMode {
  BOOTSTRAP = 0,
  NORMAL_PRICING = 1,
}

export enum AccountingState {
  READY = 0,
  ROLLOVER_SWEEP = 1,
  FLOOR_SWEEP = 2,
  HALT_SWEEP = 3,
}

export enum HealthStatus {
  FLAT = 0,
  HEALTHY = 1,
  BELOW_IM = 2,
  BELOW_MM = 3,
  NONPOSITIVE = 4,
}

export enum LiquidationMode {
  NONE = 0,
  REDUCE = 1,
  TAKEOVER = 2,
}

/** Identity of one read; required on every decoded value. */
export interface ViewIdentity {
  chainId: number;
  engine: string;
  blockNumber: bigint;
  asOfTime: bigint; // contract economic time (seconds)
  riskVersion: bigint;
  profileHash: string;
  markAvailable: boolean;
  markWad?: bigint; // undefined when unavailable
  cutoff?: bigint; // accounting cutoff when the source view reports one
}

/** Mirrors RiskView.AccountRiskView (contracts/src/risk/RiskView.sol). */
export interface AccountRiskViewRaw {
  trader: number;
  asOfTime: bigint;
  stage: Stage;
  cashQ: bigint;
  positionLots: bigint;
  e0Q: bigint;
  e1Q: bigint;
  markAvailable: boolean;
  markEquityQ: bigint;
  mmQ: bigint;
  imQ: bigint;
  status: HealthStatus;
  graceActive: boolean;
  graceEndsAt: bigint;
  liquidationMode: LiquidationMode;
  takeoverPredicate: number;
}

/** Projection and release fields of the engine's `previewAccount` view (TradePreview, read at the
 *  same block). Integration: A032 `accounting.ts` does not carry these; they are contract views. */
export interface AccountingFields {
  projectedFundingQ: bigint; // estimate, positive = account pays
  projectedPremiumQ: bigint; // estimate
  usableReleaseAtoms: bigint; // from the contract's release decision at this block
}

export interface Money {
  q: bigint;
  atomsFloor: bigint; // whole atoms, rounded toward negative infinity
  usdc: string;
}

export interface AccountDisplay {
  identity: ViewIdentity;
  authoritative: false;
  cash: Money;
  positionLots: bigint;
  positionClaims: string;
  endpointNo: Money;
  endpointYes: Money;
  markEquity?: Money; // undefined when the mark is unavailable
  maintenance?: Money;
  initial?: Money;
  health: string;
  grace?: { endsAt: bigint };
  liquidation: string;
  projections: { fundingDebit: Money; premium: Money; kind: "estimate"; withdrawable: false };
  withdrawableAtoms: bigint; // only the contract-decided release amount
}

export function qToMoney(q: bigint): Money {
  const atoms = q >= 0n ? q / Q : -((-q + Q - 1n) / Q);
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const usdc = `${neg ? "-" : ""}${a / ATOMS_PER_USDC}.${(a % ATOMS_PER_USDC).toString().padStart(6, "0")}`;
  return { q, atomsFloor: atoms, usdc };
}

export function lotsToClaims(lots: bigint): string {
  const neg = lots < 0n;
  const a = neg ? -lots : lots;
  return `${neg ? "-" : ""}${a / LOTS_PER_CLAIM}.${(a % LOTS_PER_CLAIM).toString().padStart(3, "0")}`;
}

export function wadToPrice(wad: bigint | undefined): string | undefined {
  if (wad === undefined) return undefined;
  return `${wad / WAD}.${(wad % WAD).toString().padStart(18, "0").slice(0, 6)}`;
}

const HEALTH_TEXT: Record<HealthStatus, string> = {
  [HealthStatus.FLAT]: "flat",
  [HealthStatus.HEALTHY]: "healthy",
  [HealthStatus.BELOW_IM]: "below initial margin",
  [HealthStatus.BELOW_MM]: "below maintenance margin",
  [HealthStatus.NONPOSITIVE]: "nonpositive equity",
};

const LIQ_TEXT: Record<LiquidationMode, string> = {
  [LiquidationMode.NONE]: "not eligible",
  [LiquidationMode.REDUCE]: "eligible for reduction",
  [LiquidationMode.TAKEOVER]: "eligible for takeover",
};

export function decodeAccount(raw: AccountRiskViewRaw, acct: AccountingFields, id: ViewIdentity): AccountDisplay {
  const markUsable = id.markAvailable && raw.markAvailable;
  return {
    identity: id,
    authoritative: false,
    cash: qToMoney(raw.cashQ),
    positionLots: raw.positionLots,
    positionClaims: lotsToClaims(raw.positionLots),
    endpointNo: qToMoney(raw.e0Q),
    endpointYes: qToMoney(raw.e1Q),
    markEquity: markUsable ? qToMoney(raw.markEquityQ) : undefined,
    maintenance: markUsable ? qToMoney(raw.mmQ) : undefined,
    initial: markUsable ? qToMoney(raw.imQ) : undefined,
    health: markUsable ? HEALTH_TEXT[raw.status] : "unavailable (no valid mark)",
    grace: raw.graceActive ? { endsAt: raw.graceEndsAt } : undefined,
    liquidation: LIQ_TEXT[raw.liquidationMode],
    projections: {
      fundingDebit: qToMoney(acct.projectedFundingQ),
      premium: qToMoney(acct.projectedPremiumQ),
      kind: "estimate",
      withdrawable: false,
    },
    withdrawableAtoms: acct.usableReleaseAtoms,
  };
}

/** Mirrors RiskView.MarketRiskView. */
export interface MarketRiskViewRaw {
  asOfTime: bigint;
  stage: Stage;
  pricingMode: PricingMode;
  accountingState: AccountingState;
  indexAvailable: boolean;
  indexWad: bigint;
  markAvailable: boolean;
  markWad: bigint;
  riskVersion: bigint;
  secsToT: bigint;
  monitorRestricted: boolean;
  floorStatus: number;
  floorCursor: bigint;
  floorCount: bigint;
  pendingWork: number;
}

export const PENDING = { FLOOR_SWEEP: 1, ROLLOVER_SWEEP: 2, HALT_SWEEP: 4, EPOCH_OPENING: 8 } as const;

export interface MarketDisplay {
  stage: keyof typeof Stage;
  pricing: keyof typeof PricingMode;
  tradingPausedForSweep: boolean;
  index?: string;
  mark?: string;
  pending: string[];
  floorProgress: string;
}

export function decodeMarket(raw: MarketRiskViewRaw): MarketDisplay {
  const pending: string[] = [];
  for (const [k, bit] of Object.entries(PENDING)) if ((raw.pendingWork & bit) !== 0) pending.push(k);
  return {
    stage: Stage[raw.stage] as keyof typeof Stage,
    pricing: PricingMode[raw.pricingMode] as keyof typeof PricingMode,
    tradingPausedForSweep: raw.accountingState !== AccountingState.READY,
    index: raw.indexAvailable ? wadToPrice(raw.indexWad) : undefined,
    mark: raw.markAvailable ? wadToPrice(raw.markWad) : undefined,
    pending,
    floorProgress: `${raw.floorCursor}/${raw.floorCount}`,
  };
}
