"""B007 reference: time-weighted pricing windows, basis/mark median and clamp, and the epoch
funding-rate recommendation (spec §4.1, §4.4, §6.2). Pure functions over supplied samples; no
venue fetching and no signature checks.

Units: time in integer seconds, prices in wad (1e18 = 1 USDC per claim), funding rate in Q per
lot per second. TWAP results are floored (assumption M-2). Unavailable is `None`, never 0.
"""
from dataclasses import dataclass
from fractions import Fraction as F
from typing import List, Optional, Sequence

WAD = 10**18
STALE_SECS = 30
INDEX_WINDOW = 300
PERP_WINDOW = 60
BASIS_WINDOW = 900
INVALID_WINDOW = 86400
MOVE_LOOKBACK = 300
MOVE_THRESHOLD_WAD = 10**17
BAND_WAD = 5 * 10**16        # 0.05
FUNDING_CLAMP_WAD = 5 * 10**16


@dataclass(frozen=True)
class Sample:
    t: int              # observedAt, seconds
    price_wad: int      # impact-mid (or basis, signed) in wad
    valid: bool = True  # depth/spread validity at observation time


@dataclass(frozen=True)
class TwapResult:
    available: bool
    twap_wad: Optional[int]
    covered_secs: int
    integral: F         # price-seconds over covered time (exact)


def _dedupe(samples: Sequence[Sample]) -> List[Sample]:
    """Order by time; a later sample at the same second replaces the earlier (zero weight)."""
    out: List[Sample] = []
    for s in sorted(samples, key=lambda s: s.t):
        if out and out[-1].t == s.t:
            out[-1] = s
        else:
            out.append(s)
    return out


def twap(samples: Sequence[Sample], window_end: int, window_secs: int, stale_secs: int = STALE_SECS) -> TwapResult:
    if window_secs <= 0 or stale_secs <= 0:
        raise ValueError("BAD_UNITS")
    start = window_end - window_secs
    ss = [s for s in _dedupe(samples) if s.t <= window_end]
    covered, integral = 0, F(0)
    for i, s in enumerate(ss):
        if not s.valid:
            continue
        nxt = ss[i + 1].t if i + 1 < len(ss) else None
        seg_end = s.t + stale_secs
        if nxt is not None:
            seg_end = min(seg_end, nxt)
        lo, hi = max(s.t, start), min(seg_end, window_end)
        if hi > lo:
            covered += hi - lo
            integral += F(s.price_wad) * (hi - lo)
    if covered != window_secs:
        return TwapResult(False, None, covered, integral)
    v = integral / window_secs
    return TwapResult(True, v.numerator // v.denominator, covered, integral)


def value_at(samples: Sequence[Sample], t: int, stale_secs: int = STALE_SECS) -> Optional[int]:
    """Latest sample at or before t if it is valid and fresh at t (t - observedAt <= stale)."""
    last = None
    for s in _dedupe(samples):
        if s.t <= t:
            last = s
    if last is None or not last.valid or t - last.t > stale_secs:
        return None
    return last.price_wad


def impact_mid(impact_bid_wad: int, impact_ask_wad: int, bid_depth_lots: int, ask_depth_lots: int,
               depth_n_lots: int, max_spread_wad: int) -> Optional[int]:
    """Usable only if both sides can price N and the spread check passes."""
    if depth_n_lots <= 0:
        raise ValueError("BAD_UNITS: N > 0")
    if bid_depth_lots < depth_n_lots or ask_depth_lots < depth_n_lots:
        return None
    if not (0 < impact_bid_wad <= impact_ask_wad < WAD):
        return None
    if impact_ask_wad - impact_bid_wad > max_spread_wad:
        return None
    return (impact_bid_wad + impact_ask_wad) // 2


def basis_samples(perp: Sequence[Sample], index: Sequence[Sample], stale_secs: int = STALE_SECS) -> List[Sample]:
    """Basis = perp impact-mid minus contemporaneous index; invalid if either is unavailable."""
    out = []
    for p in _dedupe(perp):
        i = value_at(index, p.t, stale_secs)
        if not p.valid or i is None:
            out.append(Sample(p.t, 0, False))
        else:
            out.append(Sample(p.t, p.price_wad - i, True))
    return out


def band_wad(now: int, scheduled_t: int, listed_at: int) -> int:
    """b(t) = 0.05 max(T-t, 0) / (T - listedAt), floored (narrower band)."""
    if scheduled_t <= listed_at:
        raise ValueError("BAD_UNITS: T > listedAt")
    return BAND_WAD * max(scheduled_t - now, 0) // (scheduled_t - listed_at)


def mark(index_wad: Optional[int], basis_twap_wad: Optional[int], perp_twap_wad: Optional[int],
         perp_live_wad: Optional[int], now: int, scheduled_t: int, listed_at: int) -> Optional[int]:
    """median(I + basis, perp 60s TWAP, live perp) clamped to I +- b(t) and [0, 1]. All three
    candidates and I must be available in v1; otherwise the normal mark is unavailable."""
    if None in (index_wad, basis_twap_wad, perp_twap_wad, perp_live_wad):
        return None
    cands = sorted([index_wad + basis_twap_wad, perp_twap_wad, perp_live_wad])
    b = band_wad(now, scheduled_t, listed_at)
    m = max(index_wad - b, min(index_wad + b, cands[1]))
    return max(0, min(WAD, m))


def funding_rate(mark_wad: int, index_wad: int) -> int:
    """r = trunc0(f * 1000 * Q / 86400) Q/lot/s, f = clamp(q - I, +-0.05 min(I, 1-I)) per claim-day."""
    for v in (mark_wad, index_wad):
        if not (0 <= v <= WAD):
            raise ValueError("BAD_UNITS: wad price")
    bound = FUNDING_CLAMP_WAD * min(index_wad, WAD - index_wad) // WAD
    f = max(-bound, min(bound, mark_wad - index_wad))
    r = abs(f) * 1000 // 86400
    return r if f >= 0 else -r


def clamp_bound_exact(index_wad: int) -> F:
    return F(FUNDING_CLAMP_WAD, WAD) * min(index_wad, WAD - index_wad)


@dataclass(frozen=True)
class EpochFunding:
    authorized: bool
    rate_q_per_lot_sec: int
    reason: str


def recommend_epoch_rate(mark_wad: Optional[int], index_wad: Optional[int], oi_lots: int,
                         funding_enabled: bool) -> EpochFunding:
    """Rate chosen once at a successful epoch opening. Zero OI disables funding for the epoch."""
    if not funding_enabled:
        return EpochFunding(False, 0, "FUNDING_DISABLED")
    if mark_wad is None or index_wad is None:
        return EpochFunding(False, 0, "STALE_PRICE")
    if oi_lots == 0:
        return EpochFunding(False, 0, "ZERO_OI")
    return EpochFunding(True, funding_rate(mark_wad, index_wad), "OK")


def movement_trigger(index: Sequence[Sample], now: int, lookback: int = MOVE_LOOKBACK,
                     threshold_wad: int = MOVE_THRESHOLD_WAD) -> bool:
    """Reduce-only + monitoring when |p(now) - p(now - 300)| > 0.10. Missing data never triggers
    here (freshness rules restrict separately); the observed path is not smoothed."""
    a, b = value_at(index, now), value_at(index, now - lookback)
    if a is None or b is None:
        return False
    return abs(a - b) > threshold_wad
