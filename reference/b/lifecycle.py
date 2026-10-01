"""B009 reference: derived stages, grace anchors, cutoff precedence, bootstrap transition,
INVALID capture readiness and finality acceptance as pure transitions (spec §5.1, §6.4, §8.3–8.5).

Nothing here reads or returns cash, positions or balances: time and flags only produce decisions.
Time is integer Unix seconds.
"""
from dataclasses import dataclass
from typing import Optional, Tuple

GRACE_START = 45000        # T - 12h30m
FLOOR_START = 43200        # T - 12h
REDUCE_ONLY_START = 3600   # T - 1h
INVALID_WINDOW = 86400
INVALID_GRACE = 3600
VOID_SECS = 30 * 86400
MIN_LISTING_HORIZON = 86400

STAGES = ("TRADING", "BACKING_GRACE", "BACKING_FLOOR", "REDUCE_ONLY", "HALTED", "CLAIMS_READY")


class ConflictingFinalOutcome(Exception):
    pass


@dataclass(frozen=True)
class StageView:
    stage: str
    full_backing_by_time: bool    # new commitments must be exactly backed
    funding_frozen: bool          # at/after T-12h
    legacy_takeover_window: bool  # floor: legacy deficient accounts eligible for bounded takeover
    halted: bool


def derive_stage(now: int, scheduled_t: int, economic_halt_at: Optional[int] = None,
                 monitor_restricted: bool = False, claims_ready: bool = False) -> StageView:
    """Strongest applicable restriction wins; boundaries are inclusive. Derived from time on
    every call: no keeper transition is needed for a restriction to apply."""
    halted = now >= scheduled_t or (economic_halt_at is not None and now >= economic_halt_at)
    to_t = scheduled_t - now
    floor = to_t <= FLOOR_START
    grace = to_t <= GRACE_START
    if halted:
        stage = "CLAIMS_READY" if claims_ready else "HALTED"
    elif to_t <= REDUCE_ONLY_START or monitor_restricted:
        stage = "REDUCE_ONLY"
    elif floor:
        stage = "BACKING_FLOOR"
    elif grace:
        stage = "BACKING_GRACE"
    else:
        stage = "TRADING"
    return StageView(stage, grace or halted, floor or halted, floor and not halted, halted)


def economic_halt_at(scheduled_t: int, early_halt_at: Optional[int]) -> int:
    """Scheduled markets halt economically at T even if the keeper is late; an accepted early
    halt uses its own (earlier) transaction time."""
    if early_halt_at is not None and early_halt_at < scheduled_t:
        return early_halt_at
    return scheduled_t


def accrual_cutoff(halt_at: int, active_epoch_end: int, frozen_rollover_cutoff: Optional[int] = None) -> int:
    """min(economicHaltAt, activeEpoch.end), respecting an already-frozen rollover cutoff."""
    end = active_epoch_end if frozen_rollover_cutoff is None else min(active_epoch_end, frozen_rollover_cutoff)
    return min(halt_at, end)


def funding_cutoff(now: int, active_epoch_end: int, scheduled_t: int, funding_stop_at: Optional[int],
                   funding_fresh_through: int, halt_at: Optional[int] = None,
                   frozen_rollover_cutoff: Optional[int] = None) -> int:
    """Earliest of: now, epoch end, frozen rollover cutoff, halt, T-12h, a recorded stop and the
    continuous-freshness endpoint. Never later than any stop."""
    c = min(now, active_epoch_end, scheduled_t - FLOOR_START, funding_fresh_through)
    for opt in (funding_stop_at, halt_at, frozen_rollover_cutoff):
        if opt is not None:
            c = min(c, opt)
    return c


@dataclass(frozen=True)
class GraceState:
    anchor: Optional[int]   # effectiveAt of the risk epoch in which deficiency was first seen


def grace_on_touch(g: GraceState, below_im: bool, risk_epoch_effective_at: int) -> GraceState:
    """Nonrenewable: the anchor is set once and cleared only when the account is observed at or
    above IM. Touching a still-deficient account does not move it (assumption M-5)."""
    if not below_im:
        return GraceState(None)
    if g.anchor is not None:
        return g
    return GraceState(risk_epoch_effective_at)


def grace_expired(g: GraceState, grace_secs: int, now: int, scheduled_t: int, below_mm: bool) -> bool:
    if below_mm:
        return True  # below MM has no grace
    if g.anchor is None:
        return False
    return now >= min(g.anchor + grace_secs, scheduled_t - FLOOR_START)


@dataclass(frozen=True)
class PricingDecision:
    mode: str        # BOOTSTRAP or NORMAL_PRICING
    admission: str   # LEVERAGED, BACKED_ONLY, NONE


def pricing_transition(mode: str, at_completed_epoch_opening: bool, index_valid: bool, basis_valid: bool,
                       perp_twap_valid: bool, perp_live_valid: bool, halted: bool) -> PricingDecision:
    """BOOTSTRAP -> NORMAL only at a completed epoch opening with all candidates valid. A normal
    market with a missing candidate falls back to backed-only admission while the index is valid.
    Halt overrides every pricing mode."""
    if mode not in ("BOOTSTRAP", "NORMAL_PRICING"):
        raise ValueError("BAD_UNITS: mode")
    all_valid = index_valid and basis_valid and perp_twap_valid and perp_live_valid
    if mode == "BOOTSTRAP" and at_completed_epoch_opening and all_valid:
        mode = "NORMAL_PRICING"
    if halted or not index_valid:
        return PricingDecision(mode, "NONE")
    if mode == "NORMAL_PRICING" and all_valid:
        return PricingDecision(mode, "LEVERAGED")
    return PricingDecision(mode, "BACKED_ONLY")


def listing_valid(listed_at: int, scheduled_t: int, grace: int = INVALID_GRACE, void_secs: int = VOID_SECS) -> bool:
    return scheduled_t - listed_at >= MIN_LISTING_HORIZON and scheduled_t + grace <= listed_at + void_secs


def invalid_readiness(now: int, scheduled_t: int, window_complete: bool, fallback_listed: bool,
                      grace: int = INVALID_GRACE) -> str:
    """NOT_YET / CAPTURE_TWAP / WAIT_GRACE / CAPTURE_FALLBACK / BLOCKED. Early INVALID waits for T;
    the 0.5 fallback applies only to listings that disclosed it, and only after T + grace."""
    if now < scheduled_t:
        return "NOT_YET"
    if window_complete:
        return "CAPTURE_TWAP"
    if not fallback_listed:
        return "BLOCKED"
    return "CAPTURE_FALLBACK" if now >= scheduled_t + grace else "WAIT_GRACE"


def invalid_window(scheduled_t: int) -> Tuple[int, int]:
    return scheduled_t - INVALID_WINDOW, scheduled_t


def accept_finality(stored: str, incoming: str) -> Tuple[str, bool]:
    """UNSET accepts; the same outcome is idempotent (newly=False); a different one reverts."""
    if incoming not in ("NO", "YES", "INVALID"):
        raise ValueError("BAD_UNITS: outcome")
    if stored == "UNSET":
        return incoming, True
    if stored == incoming:
        return stored, False
    raise ConflictingFinalOutcome(f"{stored} then {incoming}")


def oracle_call_for(oracle_outcome: str) -> Tuple[str, Optional[int]]:
    """External oracle enum {NONE, YES, NO, INVALID, VOIDED} -> engine call. Never an ABI cast."""
    return {"YES": ("settle", 1), "NO": ("settle", 0), "INVALID": ("settleInvalid", None),
            "VOIDED": ("settleInvalid", None)}[oracle_outcome]


def claims_ready(finality: str, price_ready: bool, snapshot_complete: bool, payout_complete: bool,
                 liabilities_covered: bool) -> str:
    if finality == "UNSET":
        return "AWAITING_OUTCOME"
    if not price_ready:
        return "ORACLE_FINAL_PRICE_PENDING"
    if not (snapshot_complete and payout_complete):
        return "ORACLE_FINAL_PREPARING"
    if not liabilities_covered:
        return "RECOVERY_REQUIRED"
    return "CLAIMABLE"
