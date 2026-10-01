"""B008 reference: liquidation eligibility, allowed-reduction predicate, conservative size
estimate, fee-aware bankruptcy tick, pacing and continuation decisions (spec §5.2, DEC-13).

Immutable inputs only. Ledger units: Q, lots, ticks, wad. The margin kernel is B005. Takeover
authorization is a separate function that never sees a caller work budget.
"""
from dataclasses import dataclass, field
from fractions import Fraction as F
from typing import List, Optional, Sequence, Tuple

from reference.b import margin as mg
from reference.b.horizon_volatility import ceil_frac, sqrt_bounds

Q = 10**18
U = 1000 * Q
FEE_Q_PER_LOT = Q  # 0.001 USDC per claim = one atom per lot


@dataclass(frozen=True)
class Snap:
    """Account view at one frozen price, after any fee in the transition being judged."""
    x_lots: int
    e0_q: int
    e1_q: int
    em_q: int
    mm_q: int


def snap(cash_q: int, x_lots: int, q_wad: int, secs_to_t: F, p: mg.RiskProfile) -> Snap:
    h = mg.health(cash_q, x_lots, q_wad, secs_to_t, p)
    return Snap(x_lots, h.e0_q, h.e1_q, h.mark_equity_q, h.mm_q)


def allowed_reduction(b: Snap, a: Snap) -> bool:
    """Spec §4.3 partial-reduction predicate for an initially positive-equity account."""
    if b.x_lots == 0 or b.em_q <= 0:
        return False
    if abs(a.x_lots) >= abs(b.x_lots):
        return False
    if a.x_lots != 0 and (a.x_lots > 0) != (b.x_lots > 0):
        return False
    if max(0, -a.e0_q) > max(0, -b.e0_q) or max(0, -a.e1_q) > max(0, -b.e1_q):
        return False
    if a.em_q < 0:
        return False
    return a.em_q - a.mm_q >= min(b.em_q - b.mm_q, 0)


def eligibility(price_fresh: bool, floor_active: bool, grace_expired: bool,
                e0_q: int, e1_q: int, em_q: Optional[int], mm_q: Optional[int], im_q: Optional[int]) -> str:
    """NONE / REDUCE / TAKEOVER. Price-free routes first; a stale mark alone never authorizes."""
    if floor_active and (e0_q < 0 or e1_q < 0):
        return "TAKEOVER"
    if e0_q <= 0 and e1_q <= 0 and (e0_q, e1_q) != (0, 0):
        return "TAKEOVER"
    if not price_fresh or em_q is None:
        return "NONE"
    if em_q <= 0:
        return "TAKEOVER"
    if em_q < mm_q:
        return "REDUCE"
    if grace_expired and em_q < im_q:
        return "REDUCE"
    return "NONE"


def authorize_takeover(price_fresh: bool, floor_active: bool, e0_q: int, e1_q: int, em_q: Optional[int]) -> bool:
    """Only E <= 0 (fresh), floor endpoint deficit, or both endpoints nonpositive. No work budget
    or liquidity input exists here, so neither can authorize a takeover."""
    if floor_active and (e0_q < 0 or e1_q < 0):
        return True
    if e0_q <= 0 and e1_q <= 0 and (e0_q, e1_q) != (0, 0):
        return True
    return bool(price_fresh and em_q is not None and em_q <= 0)


def size_estimate_lots(im_q: int, em_q: int, x_lots: int, s: F, lam_per_claim: F) -> Tuple[int, bool]:
    """Source estimate, rearranged so nothing divides by x:
        g = IM - E, D = IM - s|x|, delta = 2 g |x| / (D + sqrt(D^2 - 2 lambda g x^2))   (claims)
    Valid only for g > 0, D > 0 and a nonnegative discriminant; otherwise a full close attempt.
    Rounded up to lots and clamped to |x|. An estimate only: callers recheck actual margin."""
    n = abs(x_lots)
    if n == 0:
        return 0, False
    usdc = F(1, 10**24)
    g = F(im_q) * usdc - F(em_q) * usdc
    ax = F(n, 1000)
    d = F(im_q) * usdc - s * ax
    if g <= 0 or d <= 0:
        return n, True
    disc = d * d - 2 * lam_per_claim * g * ax * ax
    if disc < 0:
        return n, True
    root_lo, _ = sqrt_bounds(disc)  # smaller root -> larger estimate (round up)
    delta_claims = 2 * g * ax / (d + root_lo)
    return min(n, ceil_frac(delta_claims * 1000)), False


def bankruptcy_tick(x_lots: int, close_lots: int, cash_q: int, q_wad: int, fee_q: int,
                    threshold_q: int) -> Tuple[Optional[int], bool]:
    """Worst tick at which closing `close_lots` keeps mark equity after fees >= threshold.
    Long sells: t >= ceil(...); short buys: t <= floor(...). Returns (tick, feasible)."""
    if close_lots <= 0 or close_lots > abs(x_lots):
        raise ValueError("BAD_UNITS: 0 < close <= |x|")
    m_q = 1000 * q_wad
    n = close_lots
    if x_lots > 0:
        need = threshold_q - cash_q + fee_q - (x_lots - n) * m_q
        t = -((-need) // (n * Q))
        if t > 999:
            return None, False
        return max(t, 1), True
    have = cash_q - fee_q + (x_lots + n) * m_q - threshold_q
    t = have // (n * Q)
    if t < 1:
        return None, False
    return min(t, 999), True


def fee_allowed_q(lots: int, before: Snap, after_no_fee: Snap, threshold_q: int) -> int:
    """Largest fee <= one atom per lot that keeps E >= threshold and both deficits nonincreasing."""
    cap = lots * FEE_Q_PER_LOT
    d0b, d1b = max(0, -before.e0_q), max(0, -before.e1_q)
    f = min(cap, after_no_fee.em_q - threshold_q, after_no_fee.e0_q + d0b, after_no_fee.e1_q + d1b)
    return max(0, f)


@dataclass
class CloseResult:
    status: str                                     # DONE, NEEDS_MORE_WORK, NOT_ELIGIBLE, TAKEOVER_AUTHORIZED, DISABLED
    cash_q: int
    x_lots: int
    fills: List[Tuple[int, int, int]] = field(default_factory=list)   # (tick, lots, feeQ)
    examined: int = 0


def book_close(cash_q: int, x_lots: int, q_wad: int, secs_to_t: F, p: mg.RiskProfile,
               levels: Sequence[Tuple[int, int]], max_lots: int, max_examinations: int,
               block_budget_lots: Optional[int], price_fresh: bool = True,
               grace_expired: bool = False, floor_active: bool = False) -> CloseResult:
    """Bounded reduce-only IOC against opposite `levels` [(tick, lots)] in priority order.

    Each candidate fill is rechecked against the actual size-dependent margin after fees and the
    allowed-reduction predicate. Work or liquidity exhaustion with positive equity returns
    NEEDS_MORE_WORK; it never turns into a takeover."""
    if max_lots <= 0 or max_examinations <= 0:
        raise ValueError("zero liquidation work budget rejected")
    h = mg.health(cash_q, x_lots, q_wad, secs_to_t, p)
    mode = eligibility(price_fresh, floor_active, grace_expired, h.e0_q, h.e1_q,
                       h.mark_equity_q if price_fresh else None, h.mm_q, h.im_q)
    if mode == "TAKEOVER":
        return CloseResult("TAKEOVER_AUTHORIZED", cash_q, x_lots)
    if mode == "NONE":
        return CloseResult("NOT_ELIGIBLE", cash_q, x_lots)
    if block_budget_lots is None:
        return CloseResult("DISABLED", cash_q, x_lots)  # no measured maxLiqLotsPerBlock
    remaining_work = min(max_lots, block_budget_lots)
    res = CloseResult("NEEDS_MORE_WORK", cash_q, x_lots)
    for tick, avail in levels:
        if res.examined >= max_examinations or remaining_work == 0 or res.x_lots == 0:
            break
        res.examined += 1  # one examined maker, whatever happens below
        while avail > 0 and remaining_work > 0 and res.x_lots != 0:
            cur = snap(res.cash_q, res.x_lots, q_wad, secs_to_t, p)
            cur_h = mg.health(res.cash_q, res.x_lots, q_wad, secs_to_t, p)
            est, _full = size_estimate_lots(cur_h.im_q, cur_h.mark_equity_q, res.x_lots, p.s, p.lam)
            n = min(max(est, 1), avail, remaining_work, abs(res.x_lots))
            sign = 1 if res.x_lots > 0 else -1
            rem = res.x_lots - sign * n
            # Threshold uses the size-dependent MM of the smaller remaining position.
            mm_after = snap(0, rem, q_wad, secs_to_t, p).mm_q
            threshold = max(0, mm_after + min(cur.em_q - cur.mm_q, 0))
            worst, feasible = bankruptcy_tick(res.x_lots, n, res.cash_q, q_wad, 0, threshold)
            if not feasible or (sign > 0 and tick < worst) or (sign < 0 and tick > worst):
                return res  # remaining liquidity is beyond the permitted price
            cash_nofee = res.cash_q + sign * n * tick * Q
            after_nofee = snap(cash_nofee, rem, q_wad, secs_to_t, p)
            fee = fee_allowed_q(n, cur, after_nofee, threshold)
            after = snap(cash_nofee - fee, rem, q_wad, secs_to_t, p)
            if not allowed_reduction(cur, after):
                return res
            res.cash_q, res.x_lots = cash_nofee - fee, rem
            res.fills.append((tick, n, fee))
            remaining_work -= n
            avail -= n
            if res.x_lots == 0 or mg.health(res.cash_q, res.x_lots, q_wad, secs_to_t, p).status == "HEALTHY":
                res.status = "DONE"
                return res
    return res
