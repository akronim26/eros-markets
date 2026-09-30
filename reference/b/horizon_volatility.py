"""B003 reference: closeout horizon and volatility upper bound (spec §4.2).

Pure functions in the risk kernel's own units: claims, USDC, seconds and days. Exact values use
Fraction. Square roots return a directed interval (lo, hi) with lo <= true value <= hi. No floats.
"""
from dataclasses import dataclass
from fractions import Fraction as F
from math import isqrt
from typing import Optional, Sequence, Tuple

SQRT_SCALE = 10**40  # interval width about 1e-40 for values near 1


class CalibrationError(ValueError):
    """Raised when an empirical envelope is not a valid nondecreasing upper envelope."""


def ceil_frac(v: F) -> int:
    return -((-v.numerator) // v.denominator)


def floor_frac(v: F) -> int:
    return v.numerator // v.denominator


def sqrt_bounds(v: F) -> Tuple[F, F]:
    """Directed square root: lo <= sqrt(v) <= hi, both rationals, for v >= 0."""
    if v < 0:
        raise ValueError("sqrt of negative")
    if v == 0:
        return F(0), F(0)
    s2 = SQRT_SCALE * SQRT_SCALE
    lo_rad = floor_frac(v * s2)
    hi_rad = ceil_frac(v * s2)
    lo = isqrt(lo_rad)
    hi = isqrt(hi_rad)
    if hi * hi < hi_rad:
        hi += 1
    return F(lo, SQRT_SCALE), F(hi, SQRT_SCALE)


def horizon_exact(abs_claims: F, h0_secs: F, absorption_claims_per_min: F, queue_secs: F = F(0)) -> F:
    """h = h0 + queue + |x| / v, in seconds. Nondecreasing in |x| and queue."""
    if absorption_claims_per_min <= 0:
        raise ValueError("BAD_UNITS: absorption must be positive")
    if abs_claims < 0 or h0_secs < 0 or queue_secs < 0:
        raise ValueError("BAD_UNITS: negative size or duration")
    return F(h0_secs) + F(queue_secs) + F(abs_claims) * 60 / F(absorption_claims_per_min)


def horizon_secs_up(abs_claims: F, h0_secs: int, absorption_claims_per_min: int, queue_secs: int = 0) -> int:
    """Integer seconds rounded UP, the value the contract kernel uses."""
    return ceil_frac(horizon_exact(F(abs_claims), F(h0_secs), F(absorption_claims_per_min), F(queue_secs)))


def sigma_theory(q: F, h_secs: F, secs_to_t: F) -> Tuple[F, F]:
    """sqrt(q(1-q) h / max(T-t, 1s)), capped at 1. Returns (lo, hi)."""
    if not (0 < q < 1):
        raise ValueError("UNAVAILABLE: live risk needs an interior price")
    rad = q * (1 - q) * F(h_secs) / max(F(secs_to_t), F(1))
    lo, hi = sqrt_bounds(rad)
    return min(lo, F(1)), min(hi, F(1))


@dataclass(frozen=True)
class Envelope:
    """Empirical sigma upper envelope: bins of (horizon seconds, sigma), valid in [valid_from, valid_until)."""
    bins: Tuple[Tuple[int, F], ...]
    valid_from: int
    valid_until: int


def validate_envelope(env: Envelope) -> None:
    if not env.bins:
        raise CalibrationError("empty envelope")
    prev_h, prev_s = None, None
    for h, s in env.bins:
        if s < 0 or h < 0:
            raise CalibrationError("negative bin")
        if prev_h is not None and h <= prev_h:
            raise CalibrationError("horizons must strictly increase")
        if prev_s is not None and s < prev_s:
            raise CalibrationError("nonmonotone empirical bins: sigma decreases as h grows")
        prev_h, prev_s = h, s


def make_envelope(raw_bins: Sequence[Tuple[int, F]], valid_from: int, valid_until: int) -> Envelope:
    """Declared conservative conversion for calibration tooling: running maximum from short to long h.

    Each output value is >= every raw estimate at the same or shorter horizon, so the result is
    nondecreasing and never below a raw bin.
    """
    out, m = [], F(0)
    for h, s in sorted(raw_bins):
        m = max(m, F(s))
        out.append((h, m))
    env = Envelope(tuple(out), valid_from, valid_until)
    validate_envelope(env)
    return env


def envelope_at(env: Optional[Envelope], h_secs: F, now: int) -> Optional[F]:
    """Step-up envelope value at h, or None (unavailable => full backing).

    Uses the first bin whose horizon is >= h; never interpolates downward. Raw nonmonotone bins
    are rejected, not silently repaired.
    """
    if env is None:
        return None
    validate_envelope(env)
    if not (env.valid_from <= now < env.valid_until):
        return None
    for h, s in env.bins:
        if F(h) >= F(h_secs):
            return F(s)
    return None


def sigma_upper(theory_hi: F, realized: Optional[F], template: Optional[F]) -> Optional[F]:
    """max(theory, realized, template) capped at 1; None if an empirical input is missing."""
    if realized is None or template is None:
        return None
    return min(F(1), max(theory_hi, realized, template))
