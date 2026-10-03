"""Holdout measurement (plan §10 steps 4-5, §14.3, task O39.5).

Per category, on the holdout records only, with the frozen gate (gate/gate.json: θ_hi) and maps
(calibration/maps.json): the bucket is every market whose three labels are the same YES or NO with every calibrated
confidence ≥ θ_hi; N is the number of unique parents in it and k the number of those parents with any wrong market in
it; U95 = BetaInv(0.95; k+1, N−k) exactly (bound.py), as u95Bps rounded up. A category with no holdout market in the
bucket has N = 0 and U95 = 100%. Also: the error correlation φ between the models on the holdout (display), and the
watchdog's miss rate f on the panel's own errors: of the holdout markets whose majority label is a known outcome
other than the official one, the share where the watchdog model did not answer the official outcome.

  python3 -m measure.measure      # writes measure/measure.json
"""

from __future__ import annotations

import json
from collections import defaultdict
from fractions import Fraction
from itertools import combinations
from pathlib import Path

from gate import calibrate
from gate.gate import CATEGORIES, GATE_FILE, MAPS_FILE, RUNS_FILE, bucket, error_correlation, load_runs, sha256_file

from .bound import passes, percent, u95_bps

HERE = Path(__file__).resolve().parent
OUT = HERE / "measure.json"


def per_category(holdout: list[dict], maps: list[dict], theta: int) -> dict:
    out = {}
    for c in CATEGORIES:
        recs = [r for r in holdout if r["category"] == c]
        ran = [r for r in recs if r["status"] == "RUN"]
        b = bucket(ran, maps, theta)
        parents: dict[str, bool] = defaultdict(bool)  # parent → any error
        for r in b:
            parents[r["parent_id"]] |= r["outcomes"][0]["label"] != r["truth"]
        n, k = len(parents), sum(parents.values())
        u = u95_bps(k, n)
        out[c] = {"holdoutRecords": len(recs), "ran": len(ran), "bucketMarkets": len(b), "N": n, "k": k, "u95Bps": u, "u95": percent(k, n), "passes": passes(u, n)}
    return out


def watchdog_miss(holdout: list[dict]) -> dict:
    errors = []
    for r in holdout:
        if r["status"] != "RUN":
            continue
        labels = [o["label"] for o in r["outcomes"]]
        major = next((l for l in labels if labels.count(l) >= 2), None)
        if major in calibrate.KNOWN and major != r["truth"]:
            errors.append(r)
    misses = sum(1 for r in errors if r.get("watchdog", {}).get("outcome") != r["truth"])
    return {"panelErrors": len(errors), "misses": misses, "f": str(Fraction(misses, len(errors))) if errors else None}


def measure(records: list[dict], gate: dict, maps: list[dict]) -> dict:
    holdout = [r for r in records if r["split"] == "holdout"]
    ran = [r for r in holdout if r["status"] == "RUN"]
    return {
        "schema": "eros-validation-measure/1",
        "gate": {"highConfBps": gate["highConfBps"], "calibratorHash": gate["calibration"]["calibratorHash"]},
        "data": {"runsSha256": sha256_file(RUNS_FILE), "gateSha256": sha256_file(GATE_FILE), "mapsSha256": sha256_file(MAPS_FILE)},
        "holdout": {"records": len(holdout), "ran": len(ran)},
        "categories": per_category(holdout, maps, gate["highConfBps"]),
        "errorCorrelation": [error_correlation(ran, a, b) for a, b in combinations(gate["models"], 2)],
        "watchdog": watchdog_miss(holdout),
    }


def main() -> None:
    gate = json.loads(GATE_FILE.read_text())
    maps = calibrate.loads_maps(MAPS_FILE.read_text())
    OUT.write_text(json.dumps(measure(load_runs(), gate, maps), indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
