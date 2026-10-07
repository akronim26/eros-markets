// Engine enum decoding (frontend.md §7.2). Values are ABI ordinals; never reorder.

export const STAGE = ["Trading", "Final-day grace", "Final-day floor", "Reduce only", "Halted", "Claims ready"] as const;
export const PRICING = ["Bootstrap", "Normal pricing"] as const;
export const ACCOUNTING = ["Ready", "Rollover sweep", "Floor sweep", "Halt sweep"] as const;
export const HEALTH = ["Flat", "Healthy", "Below initial margin", "Below maintenance", "Nonpositive equity"] as const;
export const TEMPLATE = ["Scheduled", "Continuous", "Deadline", "Unscheduled"] as const;
export const ORDER_KIND = ["Limit", "IOC", "Post only"] as const;

export const REJECT: Record<number, string> = {
  0: "",
  1: "Market is halted; no new orders.",
  2: "Not allowed now: market not activated, reduce-only, sweep running, or final-day restriction.",
  3: "Price is outside the band around the index allowed while the market bootstraps.",
  4: "Size is below the market minimum.",
  5: "Reduce-only, but there is no opposite position to reduce.",
  6: "A resting order failed its margin re-check and was removed.",
  7: "A resting order failed its margin re-check and was removed.",
  8: "Not enough margin for this size. Reduce size or add collateral.",
  9: "Worst-case loss beyond collateral would exceed the per-account cap.",
  10: "The market reserve cannot cover more leveraged exposure right now.",
  11: "Price or size invalid for the current price state (no valid index or mark).",
  12: "Order became stale (epoch changed or expired).",
};

export const CANCEL_REASON = ["Cancelled", "Self-trade", "Failed re-check", "Clipped (reduce-only)", "Expired"] as const;

export const ORACLE_STATE = [
  "Awaiting halt",
  "Early check",
  "Early review",
  "Awaiting data feed",
  "With model panel",
  "Committee review",
  "Open to proposals",
  "Proposed",
  "Disputed",
  "Voided",
  "Final",
] as const;
export const ORACLE_OUTCOME = ["—", "YES", "NO", "INVALID"] as const;
export const ORACLE_PATH = ["—", "Layer 1 (CRE)", "Layer 2 auto", "Committee", "Permissionless"] as const;

export const PENDING_BITS = { 1: "Floor sweep", 2: "Rollover sweep", 4: "Halt sweep", 8: "Epoch opening" } as const;

export type Tone = "signal" | "warn" | "neutral" | "bid" | "ask" | "muted";

export type MarketChipInput = {
  active: boolean;
  halted: boolean;
  stage: number;
  pricingMode: number;
  accountingState: number;
  indexAvailable: boolean;
  markAvailable: boolean;
  monitorRestricted: boolean;
  claimsEnabled: boolean;
  phase: number;
  recoveryRequired: boolean;
  oracleFinalityAccepted: boolean;
};

/** One status chip, first match wins (frontend.md §13). */
export function marketChip(m: MarketChipInput): { label: string; tone: Tone } {
  if (m.claimsEnabled && m.phase === 4) return { label: "All claims paid", tone: "muted" };
  if (m.halted && m.claimsEnabled && !m.recoveryRequired) return { label: "Claims open", tone: "neutral" };
  if (m.recoveryRequired) return { label: "Recovery required", tone: "signal" };
  if (m.halted && m.oracleFinalityAccepted) return { label: "Outcome final, preparing", tone: "warn" };
  if (m.halted) return { label: "Halted, awaiting outcome", tone: "warn" };
  if (!m.active) return { label: "Not yet activated", tone: "muted" };
  if (m.accountingState !== 0) return { label: "Paused: accounting sweep", tone: "warn" };
  if (m.stage === 3) return { label: m.monitorRestricted ? "Reduce only: monitor" : "Reduce only", tone: "warn" };
  if (m.stage === 2) return { label: "Final day: full backing enforced", tone: "signal" };
  if (m.stage === 1) return { label: "Final day: top up to full backing", tone: "signal" };
  if (m.pricingMode === 0 && !m.indexAvailable) return { label: "Index window unavailable", tone: "muted" };
  if (m.pricingMode === 0) return { label: "Bootstrap: fully backed", tone: "neutral" };
  if (!m.indexAvailable || !m.markAvailable) return { label: "Waiting for fresh prices", tone: "warn" };
  return { label: "Trading", tone: "neutral" };
}
