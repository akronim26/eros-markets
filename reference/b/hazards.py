"""B004 reference: linear hazard upper bounds, adverse probability, tail budget, Cantelli factor
and conservative drift (spec §4.2, DEC-09).

All values are exact Fractions except k, which is a directed interval. A domain failure returns
TailResult(full_backing=True, ...) with the reason; callers must then require both exact endpoints.
"""
from dataclasses import dataclass
from fractions import Fraction as F
from typing import Optional, Tuple

from reference.b.horizon_volatility import sqrt_bounds

SECONDS_PER_DAY = 86400


def hazard_upper(hazard_per_day: F, h_secs: F) -> F:
    """a = min(1, hazard * h / 86400). Upper bound of 1 - exp(-hazard*h) for hazard >= 0."""
    if hazard_per_day < 0 or h_secs < 0:
        raise ValueError("BAD_UNITS: negative hazard or horizon")
    return min(F(1), F(hazard_per_day) * F(h_secs) / SECONDS_PER_DAY)


@dataclass(frozen=True)
class TailResult:
    full_backing: bool
    reason: str
    a_adv: Optional[F] = None
    eps_prime: Optional[F] = None       # residual tail budget (exact)
    k: Optional[Tuple[F, F]] = None     # Cantelli factor interval (lo, hi)


def tail(a0: F, a1: F, is_long: bool, epsilon: F) -> TailResult:
    """Directional tail budget. Long adverse hazard is a0 (NO jump), short is a1 (YES jump)."""
    if not (0 < epsilon < 1):
        raise ValueError("BAD_UNITS: epsilon must be interior")
    if a0 + a1 >= 1:
        return TailResult(True, "a0+a1>=1")
    a_adv = a0 if is_long else a1
    if a_adv >= epsilon:
        return TailResult(True, "a_adv>=epsilon", a_adv=a_adv)
    eps_prime = (epsilon - a_adv) / (1 - a_adv)
    if eps_prime <= 0:
        return TailResult(True, "epsilon' rounds to 0", a_adv=a_adv, eps_prime=eps_prime)
    k = sqrt_bounds((1 - eps_prime) / eps_prime)
    return TailResult(False, "ok", a_adv=a_adv, eps_prime=eps_prime, k=k)


def adverse_drift(q: F, a0: F, a1: F, is_long: bool) -> Optional[F]:
    """mLong = (1-q) a1 / (1-a0-a1); mShort = q a0 / (1-a0-a1). None if a0+a1 >= 1.

    These drop the favorable source terms (-q a0 for a long, -(1-q) a1 for a short), so they are
    never below the source conditional drift.
    """
    denom = 1 - a0 - a1
    if denom <= 0:
        return None
    return ((1 - q) * a1 if is_long else q * a0) / denom


def source_conditional_drift(q: F, a0: F, a1: F, is_long: bool) -> Optional[F]:
    """Full source drift including the favorable term, for tests only: adverse move of
    E[q | no jump] relative to q, from q = a1*1 + a0*0 + (1-a0-a1) E[q | no jump]."""
    denom = 1 - a0 - a1
    if denom <= 0:
        return None
    no_jump = (q - a1) / denom
    return q - no_jump if is_long else no_jump - q
