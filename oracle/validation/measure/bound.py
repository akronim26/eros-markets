"""The auto gate's error bound (plan §10 step 4, §14.3, task O39.5), in exact rationals.

U95 = BetaInv(0.95; k+1, N−k) is the Clopper–Pearson one-sided 95% upper bound on the error rate after k errors in N
unique parents: the p at which P(X ≤ k | N, p) = 0.05. The binomial tail F(p) = Σ_{i≤k} C(N,i) p^i (1−p)^(N−i)
falls strictly as p rises (for k < N), so U95 ≤ b/10,000 exactly when F(b/10,000) ≤ 1/20. u95Bps, the value the
registry stores, is the smallest such b (U95 rounded up to a basis point), found by bisection over b with F evaluated
exactly at each rational. No float is involved; at k = 0, F(p) = (1 − p)^N, so U95 = 1 − 0.05^(1/N).
N = 0 bounds nothing: U95 = 1 (10,000 bps). k = N: U95 = 1.
"""

from __future__ import annotations

from fractions import Fraction
from math import comb

ALPHA = Fraction(1, 20)
BPS = 10_000


def tail(k: int, n: int, p: Fraction) -> Fraction:
    """P(X ≤ k) for X ~ Binomial(n, p), exactly."""
    return sum((comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k + 1)), Fraction(0))


def u95_bps(k: int, n: int) -> int:
    """The smallest b with U95 ≤ b / 10,000."""
    if not 0 <= k <= n:
        raise ValueError(f"k = {k} errors in N = {n}")
    if n == 0 or k == n:
        return BPS
    lo, hi = 0, BPS  # F(0) = 1 > α; F(1) = 0 ≤ α
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if tail(k, n, Fraction(mid, BPS)) <= ALPHA:
            hi = mid
        else:
            lo = mid
    return hi


def u95_interval(k: int, n: int, places: int = 6) -> tuple[Fraction, Fraction]:
    """[lo, hi] of width 10^-places with lo < U95 ≤ hi, by bisection on F (for the report's display)."""
    if n == 0 or k == n:
        return Fraction(1), Fraction(1)
    scale = 10**places
    lo, hi = 0, scale
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if tail(k, n, Fraction(mid, scale)) <= ALPHA:
            hi = mid
        else:
            lo = mid
    return Fraction(lo, scale), Fraction(hi, scale)


def percent(k: int, n: int, decimals: int = 2) -> str:
    """U95 as a percentage rounded half up to `decimals` (display only; the gate uses u95_bps)."""
    lo, hi = u95_interval(k, n, places=decimals + 6)
    q = Fraction(10 ** (decimals + 2))
    v = (hi * q * 2 + 1) // 2  # half up on the upper end; the interval is far narrower than the last digit
    whole, frac = divmod(int(v), 10**decimals)
    return f"{whole}.{frac:0{decimals}d}%"


def passes(u95: int, n: int, delta_pmax_bps: int = 200, n_min: int = 150) -> bool:
    """The validation rule: U95 ≤ Δp_max and N ≥ N_min."""
    return u95 <= delta_pmax_bps and n >= n_min
