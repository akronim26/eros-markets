"""Task O39.5: the holdout measurement (plan §10 steps 4-5, §14.3).

U95 is checked against values derived independently of bound.py: the closed form 1 − 0.05^(1/N) at k = 0 through
(1 − b/10,000)^N against 1/20 in exact rationals, published Clopper–Pearson values for k > 0, and the task's
1.98% (N = 150), 1.99% (N = 149) and 0.99% (N = 300).

  cd oracle/validation && python3 -m unittest tests/test_measure.py
"""

from __future__ import annotations

import json
import unittest
from fractions import Fraction

from gate import calibrate
from gate.gate import GATE_FILE, MAPS_FILE, load_runs
from measure import measure as M
from measure.bound import passes, percent, tail, u95_bps

from .fixtures_runs import linear_maps, rec


class Bound(unittest.TestCase):
    def test_task_values_at_k0(self):
        self.assertEqual([percent(0, n) for n in (150, 149, 300)], ["1.98%", "1.99%", "0.99%"])
        self.assertEqual([u95_bps(0, n) for n in (150, 149, 300)], [198, 200, 100])

    def test_closed_form_at_k0(self):
        # U95 = 1 − 0.05^(1/N) ≤ b/10^4  ⟺  (1 − b/10^4)^N ≤ 1/20; u95Bps is the smallest such b
        for n in (1, 2, 10, 59, 148, 149, 150, 151, 299, 300, 1000):
            b = u95_bps(0, n)
            self.assertLessEqual((1 - Fraction(b, 10_000)) ** n, Fraction(1, 20), n)
            self.assertGreater((1 - Fraction(b - 1, 10_000)) ** n, Fraction(1, 20), n)

    def test_known_clopper_pearson_values(self):
        # BetaInv(0.95; k+1, N−k) computed separately by numerically integrating the Beta density and bisecting
        # (not the binomial tail bound.py uses): 0.0157146 (1/300), 0.0757108 (3/100), 0.4555824 (5/20)
        self.assertEqual(percent(1, 300), "1.57%")
        self.assertEqual(percent(3, 100), "7.57%")
        self.assertEqual(percent(5, 20), "45.56%")
        self.assertEqual([u95_bps(1, 300), u95_bps(3, 100), u95_bps(5, 20)], [158, 758, 4556])

    def test_rounding_is_up_and_exact(self):
        for k, n in ((0, 150), (1, 300), (4, 77)):
            b = u95_bps(k, n)
            self.assertLessEqual(tail(k, n, Fraction(b, 10_000)), Fraction(1, 20))
            self.assertGreater(tail(k, n, Fraction(b - 1, 10_000)), Fraction(1, 20))

    def test_edges(self):
        self.assertEqual(u95_bps(0, 0), 10_000)
        self.assertEqual(u95_bps(5, 5), 10_000)
        self.assertEqual(percent(0, 0), "100.00%")
        with self.assertRaises(ValueError):
            u95_bps(3, 2)

    def test_gate_rule(self):
        self.assertTrue(passes(198, 150))
        self.assertFalse(passes(200, 149))  # U95 passes (1.99%), N does not
        self.assertTrue(passes(200, 150))
        self.assertFalse(passes(201, 1000))


class Measure(unittest.TestCase):
    def test_bucket_parents_and_errors(self):
        maps = linear_maps()
        y3 = ["YES"] * 3
        recs = [
            rec("holdout", "sports", "p1", "m1", "YES", y3, ["0.95"] * 3),
            rec("holdout", "sports", "p1", "m2", "NO", y3, ["0.95"] * 3),  # same parent, wrong: p1 counts once, as an error
            rec("holdout", "sports", "p2", "m3", "YES", y3, ["0.95", "0.95", "0.94"]),  # one below θ 9,500: not in the bucket
            rec("holdout", "sports", "p3", "m4", "NO", ["NO", "NO", "NOT_YET"], ["0.99", "0.99", "0.99"]),  # not unanimous
            rec("holdout", "sports", "p4", "m5", "NO", ["NO"] * 3, ["0.96"] * 3),
            rec("holdout", "macro", "p5", "m6", "YES", ["INVALID"] * 3, ["0.99"] * 3),  # INVALID is never auto-proposed
            rec("holdout", "macro", "p6", "m7", "YES", y3, ["0.99"] * 3, status="NO_EVIDENCE"),
            rec("train", "sports", "p7", "m8", "NO", y3, ["0.99"] * 3),  # not holdout
        ]
        out = M.per_category([r for r in recs if r["split"] == "holdout"], maps, 9500)
        self.assertEqual({k: out["sports"][k] for k in ("bucketMarkets", "N", "k")}, {"bucketMarkets": 3, "N": 2, "k": 1})
        self.assertEqual(out["sports"]["u95Bps"], u95_bps(1, 2))
        self.assertEqual({k: out["macro"][k] for k in ("holdoutRecords", "ran", "N", "u95Bps")}, {"holdoutRecords": 2, "ran": 1, "N": 0, "u95Bps": 10_000})
        self.assertEqual(out["other"]["N"], 0)

    def test_watchdog_miss_rate(self):
        recs = [
            rec("holdout", "sports", "p1", "m1", "YES", ["NO", "NO", "YES"], ["0.9"] * 3, watchdog="YES"),  # panel wrong, caught
            rec("holdout", "sports", "p2", "m2", "YES", ["NO", "NO", "NO"], ["0.9"] * 3, watchdog=None),  # wrong, missed
            rec("holdout", "sports", "p3", "m3", "NO", ["YES", "YES", "NO"], ["0.9"] * 3, watchdog="YES"),  # wrong, missed (agreed)
            rec("holdout", "sports", "p4", "m4", "NO", ["NO"] * 3, ["0.9"] * 3),  # right
            rec("holdout", "sports", "p5", "m5", "NO", ["NOT_YET"] * 3, ["0.9"] * 3),  # no claim
        ]
        self.assertEqual(M.watchdog_miss(recs), {"panelErrors": 3, "misses": 2, "f": "2/3"})
        self.assertEqual(M.watchdog_miss(recs[3:]), {"panelErrors": 0, "misses": 0, "f": None})


class Committed(unittest.TestCase):
    def test_measure_json_reproduces(self):
        gate = json.loads(GATE_FILE.read_text())
        maps = calibrate.loads_maps(MAPS_FILE.read_text())
        self.assertEqual(M.measure(load_runs(), gate, maps), json.loads(M.OUT.read_text()))


if __name__ == "__main__":
    unittest.main()
