"""B005 reference: MM, IM, full-backing switch, directional/template caps, health and displayed
leverage (spec §4.2–4.3, DEC-09).

Kernel units: claims, USDC, seconds. Every margin is an interval (lo, hi); `hi` is the upward
bound the contract must not undercut. Conversion to ledger Q happens only in `to_q_up`.

Monotone envelope argument (per sign, fixed q and T-t): h = h0 + queue + |x|/v is nondecreasing
in |x|; a_y = min(1, hazard_y h / 86400) is nondecreasing in h; eps' = (eps-a)/(1-a) is
nonincreasing in a so k = sqrt((1-eps')/eps') is nondecreasing; sigma_theory is nondecreasing in
h and the empirical envelopes are validated nondecreasing step functions; the drift terms are
nondecreasing in a0 and a1. |x|(m + k sigma + s) + lambda x^2 / 2 is a sum of products of
nonnegative nondecreasing functions of |x|, and min/max with |x| w and |x| w / L keep that
property. The full-backing switch is upward: a_adv grows with |x|, so once a size is fully
backed every larger size is too, and IM before the switch is already capped by |x| w.
`test_b005.py` checks this numerically on grids; the argument above is the proof.
"""
from dataclasses import dataclass
from fractions import Fraction as F
from typing import Optional

from reference.b import hazards as hz
from reference.b import horizon_volatility as hv

Q = 10**18
Q_PER_USDC = 10**24
PAYOFF_Q_PER_LOT = 1000 * Q

TEMPLATE_CAPS = {  # (long, short) after calibration, spec §4.3
    "SCHEDULED": (5, 5),
    "CONTINUOUS": (3, 3),
    "DEADLINE": (3, 1),
    "UNSCHEDULED": (1, 1),
}


@dataclass(frozen=True)
class RiskProfile:
    h0_secs: F
    absorption_claims_per_min: F
    queue_secs: F
    hazard0_per_day: F
    hazard1_per_day: F
    epsilon: F
    gamma: F
    s: F
    lam: F                      # lambda, per claim
    template: str
    calibrated: bool            # valid calibration and release gate evidence present
    deployment_cap: int         # manifest ceiling; initial deployment = 1
    realized: Optional[hv.Envelope]
    template_env: Optional[hv.Envelope]
    now: int                    # for calibration validity


def directional_cap(template: str, is_long: bool, calibrated: bool, deployment_cap: int) -> int:
    if deployment_cap < 1:
        raise ValueError("BAD_UNITS: cap >= 1")
    if not calibrated:
        return 1
    long_cap, short_cap = TEMPLATE_CAPS[template]
    return min(long_cap if is_long else short_cap, deployment_cap)


@dataclass(frozen=True)
class MarginResult:
    mm_lo: F
    mm_hi: F
    im_lo: F
    im_hi: F
    worst_loss: F           # |x| w exactly
    full_backing: bool
    reason: str
    cap: int


def _full(worst: F, reason: str, cap: int) -> MarginResult:
    return MarginResult(worst, worst, worst, worst, worst, True, reason, cap)


def side_margin(abs_x: F, is_long: bool, q: F, secs_to_t: F, p: RiskProfile) -> MarginResult:
    abs_x = F(abs_x)
    if abs_x < 0:
        raise ValueError("BAD_UNITS: abs_x >= 0")
    if not (0 < q < 1):
        raise ValueError("UNAVAILABLE: interior price required")
    w = q if is_long else 1 - q
    worst = abs_x * w
    cap = directional_cap(p.template, is_long, p.calibrated, p.deployment_cap)
    if abs_x == 0:
        return MarginResult(F(0), F(0), F(0), F(0), F(0), False, "flat", cap)
    if cap == 1:
        return _full(worst, "cap 1x", cap)
    h = hv.horizon_exact(abs_x, p.h0_secs, p.absorption_claims_per_min, p.queue_secs)
    a0 = hz.hazard_upper(p.hazard0_per_day, h)
    a1 = hz.hazard_upper(p.hazard1_per_day, h)
    t = hz.tail(a0, a1, is_long, p.epsilon)
    if t.full_backing:
        return _full(worst, t.reason, cap)
    m = hz.adverse_drift(q, a0, a1, is_long)
    s_lo, s_hi = hv.sigma_theory(q, h, secs_to_t)
    realized = hv.envelope_at(p.realized, h, p.now)
    templ = hv.envelope_at(p.template_env, h, p.now)
    if realized is None or templ is None:
        return _full(worst, "missing/expired calibration", cap)
    sig_lo = min(F(1), max(s_lo, realized, templ))
    sig_hi = hv.sigma_upper(s_hi, realized, templ)
    k_lo, k_hi = t.k
    quad = p.lam * abs_x * abs_x / 2
    mm_lo = min(worst, abs_x * (m + k_lo * sig_lo + p.s) + quad)
    mm_hi = min(worst, abs_x * (m + k_hi * sig_hi + p.s) + quad)
    floor_cap = worst / cap
    im_lo = min(worst, max(p.gamma * mm_lo, floor_cap))
    im_hi = min(worst, max(p.gamma * mm_hi, floor_cap))
    if im_hi >= worst:
        return MarginResult(mm_lo, mm_hi, worst, worst, worst, True, "IM cap meets bounded loss", cap)
    return MarginResult(mm_lo, mm_hi, im_lo, im_hi, worst, False, "ok", cap)


def to_q_up(usdc: F) -> int:
    """Kernel USDC -> ledger Q, rounded up (requirements)."""
    v = F(usdc) * Q_PER_USDC
    return -((-v.numerator) // v.denominator)


def endpoints(cash_q: int, lots: int):
    return cash_q, cash_q + PAYOFF_Q_PER_LOT * lots


def mark_equity(cash_q: int, lots: int, q_wad: int) -> int:
    return cash_q + 1000 * lots * q_wad


@dataclass(frozen=True)
class Health:
    status: str            # FLAT, HEALTHY, BELOW_IM, BELOW_MM, NONPOSITIVE
    e0_q: int
    e1_q: int
    mark_equity_q: int
    mm_q: int
    im_q: int
    full_backing: bool


def health(cash_q: int, lots: int, q_wad: int, secs_to_t: F, p: RiskProfile) -> Health:
    e0, e1 = endpoints(cash_q, lots)
    em = mark_equity(cash_q, lots, q_wad)
    if lots == 0:
        return Health("FLAT" if cash_q >= 0 else "NONPOSITIVE", e0, e1, em, 0, 0, False)
    r = side_margin(F(abs(lots), 1000), lots > 0, F(q_wad, Q), secs_to_t, p)
    mm_q, im_q = to_q_up(r.mm_hi), to_q_up(r.im_hi)
    if r.full_backing:
        # Exact endpoints, not a rounded mark comparison (spec §4.2).
        if e0 >= 0 and e1 >= 0:
            status = "HEALTHY"
        elif em <= 0:
            status = "NONPOSITIVE"
        else:
            status = "BELOW_MM"
        return Health(status, e0, e1, em, mm_q, im_q, True)
    if em <= 0:
        status = "NONPOSITIVE"
    elif em < mm_q:
        status = "BELOW_MM"
    elif em < im_q:
        status = "BELOW_IM"
    else:
        status = "HEALTHY"
    return Health(status, e0, e1, em, mm_q, im_q, False)


def display_leverage_bps(exposure_q: int, mark_equity_q: int):
    """Display only (assumption M-1): floor(exposure * 1e4 / E) when E > 0, else unavailable."""
    if mark_equity_q <= 0:
        return None
    return exposure_q * 10_000 // mark_equity_q


def fixture_profile(cap: int = 5, calibrated: bool = True, now: int = 0) -> RiskProfile:
    """Spec §7.9 / §9.1 local fixture: empirical envelopes explicitly zero (below theory)."""
    zero = hv.Envelope(((10**12, F(0)),), 0, 2**63)
    return RiskProfile(
        h0_secs=F(300), absorption_claims_per_min=F(1000), queue_secs=F(0),
        hazard0_per_day=F(1, 10000), hazard1_per_day=F(1, 10000),
        epsilon=F(1, 100), gamma=F(3, 2), s=F(5, 1000), lam=F(1, 10**6),
        template="SCHEDULED", calibrated=calibrated, deployment_cap=cap,
        realized=zero, template_env=zero, now=now,
    )
