"""Hand-made panel records for the gate, calibration and measurement tests (same shape as gate/panel-runs.json)."""

from __future__ import annotations

from fractions import Fraction

from gate.gate import MODELS


def rec(split, cat, parent, market, truth, labels, confs, status="RUN", watchdog=None):
    r = {"split": split, "category": cat, "rank": 0, "parent_id": parent, "market_id": market, "truth": truth, "status": status, "costInr": "0",
         "items": [], "outcomes": [{"model": m, "label": l, "confidence": None if c is None else Fraction(c), "cited": [0], "abstainReason": None} for m, l, c in zip(MODELS, labels, confs)]}
    if watchdog is not None:
        r["watchdog"] = {"model": "groq:qwen/qwen3.8-27b@2026-10-03", "outcome": watchdog}
    return r


def linear_maps():
    """Identity-like maps clipped at 0.99, so calibrated bps = floor(c × 10,000) up to 9,900."""
    return [{"model": m, "breakpoints": [[Fraction(0), Fraction(1, 100)], [Fraction(99, 100), Fraction(99, 100)]]} for m in MODELS]
