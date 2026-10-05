"""Calibration maps (plan §8.3, §10 step 3, task O39.4).

One isotonic map per model, fitted on the calibration split only. A point is one known answer (YES, NO or INVALID)
with the model's own confidence c and whether it matched the official outcome; NOT_YET and ABSTAIN claim nothing and
are left out. Grouped by parent: every parent weighs 1 in total, shared by its answers, so a parent with many sibling
markets cannot dominate. Pool-adjacent-violators on the points sorted by c gives non-decreasing block values; each
block becomes breakpoints at its lowest and highest c (the panel runner interpolates linearly between breakpoints and
holds the end values outside them, O33.3). Values are rounded down to 4 decimals (never more confident than the data)
and clipped to [0.01, 0.99]; positions are rounded to 4 decimals.

A model with known answers on fewer than MIN_PARENTS parents gets the placeholder map, 0.49 everywhere (O33.3): below
the 5,000 bps floor any highConfBps must clear, so nothing it says can open the gate or make an early check known.

calibratorHash = keccak256(JCS(the three maps, in modelIdHashes order)), computed as the panel runner computes it
(RFC 8785: keys sorted, numbers in ECMAScript form).
"""

from __future__ import annotations

from collections import defaultdict
from fractions import Fraction

from .keccak import hex32, keccak256

MIN_PARENTS = 30
CLIP = (Fraction(1, 100), Fraction(99, 100))
PLACEHOLDER = Fraction(49, 100)
SCALE = 10_000
KNOWN = ("YES", "NO", "INVALID")


def floor4(x: Fraction) -> Fraction:
    return Fraction((x.numerator * SCALE) // x.denominator, SCALE)


def round4(x: Fraction) -> Fraction:
    return Fraction((2 * x.numerator * SCALE + x.denominator) // (2 * x.denominator), SCALE)


def points(records: list[dict], model: str) -> list[tuple[Fraction, Fraction, str]]:
    """(confidence, correct as 0/1, parent) for every known answer of `model`."""
    out = []
    for r in records:
        for o in r["outcomes"]:
            if o["model"] == model and o["label"] in KNOWN and o["confidence"] is not None:
                out.append((Fraction(o["confidence"]), Fraction(int(o["label"] == r["truth"])), r["parent_id"]))
    return out


def pav(pts: list[tuple[Fraction, Fraction, Fraction]]) -> list[dict]:
    """Pool-adjacent-violators on (c, y, weight) sorted by c: blocks {lo, hi, value} with non-decreasing values."""
    blocks: list[dict] = []
    for c, y, w in sorted(pts, key=lambda p: p[0]):
        blocks.append({"lo": c, "hi": c, "sum": y * w, "w": w})
        while len(blocks) > 1 and blocks[-2]["sum"] / blocks[-2]["w"] > blocks[-1]["sum"] / blocks[-1]["w"]:
            b = blocks.pop()
            a = blocks[-1]
            a.update(hi=b["hi"], sum=a["sum"] + b["sum"], w=a["w"] + b["w"])
    return [{"lo": b["lo"], "hi": b["hi"], "value": b["sum"] / b["w"]} for b in blocks]


def fit(records: list[dict], model: str) -> dict:
    """The model's map: isotonic on the calibration records, or the placeholder when the data is too thin."""
    pts = points(records, model)
    per_parent: dict[str, int] = defaultdict(int)
    for _, _, p in pts:
        per_parent[p] += 1
    if len(per_parent) < MIN_PARENTS:
        return {"model": model, "breakpoints": [[Fraction(0), PLACEHOLDER], [Fraction(1), PLACEHOLDER]]}
    weighted = [(c, y, Fraction(1, per_parent[p])) for c, y, p in pts]
    bps: list[list[Fraction]] = []
    for b in pav(weighted):
        v = min(max(floor4(b["value"]), CLIP[0]), CLIP[1])
        for c in dict.fromkeys([round4(b["lo"]), round4(b["hi"])]):
            if bps and c <= bps[-1][0]:
                continue  # rounding merged two positions: keep the first (lower) value
            bps.append([c, max(v, bps[-1][1]) if bps else v])
    if len(bps) == 1:  # every answer at one confidence: a constant map
        bps = [[Fraction(0), bps[0][1]], [Fraction(1), bps[0][1]]]
    return {"model": model, "breakpoints": bps}


def apply(m: dict, c: Fraction) -> Fraction:
    """g(c) as the panel runner computes it: linear between breakpoints, the end values outside."""
    b = m["breakpoints"]
    if c <= b[0][0]:
        return b[0][1]
    if c >= b[-1][0]:
        return b[-1][1]
    i = next(i for i, (x, _) in enumerate(b) if x > c)
    (x0, y0), (x1, y1) = b[i - 1], b[i]
    return y0 + (y1 - y0) * (c - x0) / (x1 - x0)


def calibrated_bps(m: dict, c: Fraction) -> int:
    """floor(clip(g(c), 0.01, 0.99) × 10,000), exactly (O33.3)."""
    v = min(max(apply(m, c), CLIP[0]), CLIP[1])
    return (v.numerator * SCALE) // v.denominator


# ---- RFC 8785 for the maps' shape: objects, arrays, ASCII strings and numbers in [0, 1] with at most 4 decimals


def es_number(x: Fraction) -> str:
    """The ECMAScript Number-to-String of a decimal in [0, 1] with at most 4 places (as JSON.parse then JCS gives)."""
    if not 0 <= x <= 1 or (x * SCALE).denominator != 1:
        raise ValueError(f"{x} is not a 4-decimal number in [0, 1]")
    if x.denominator == 1:
        return str(x.numerator)
    s = f"{int(x * SCALE):04d}".rstrip("0")
    return "0." + s


def jcs(v) -> str:
    if isinstance(v, dict):
        return "{" + ",".join(f"{jcs(k)}:{jcs(v[k])}" for k in sorted(v)) + "}"
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, str):
        if not all(0x20 <= ord(ch) < 0x7F for ch in v):
            raise ValueError(f"{v!r}: only printable ASCII in map strings")
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, Fraction):
        return es_number(v)
    raise TypeError(type(v))


def dumps_maps(maps: list[dict]) -> str:
    """The maps file: one map per line, numbers written as their exact decimal tokens (no float on the way)."""
    return "[\n" + ",\n".join("  " + jcs(m) for m in maps) + "\n]\n"


def loads_maps(text: str) -> list[dict]:
    """The maps file read back with every number as an exact Fraction."""
    import json

    return json.loads(text, parse_float=Fraction, parse_int=Fraction)


def calibrator_hash(maps: list[dict]) -> str:
    return hex32(keccak256(jcs(maps).encode()))
