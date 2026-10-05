"""Task O39.6: the report's review limit and governance proposals (plan §10 steps 6-7, §14.3).

OI_review is checked against the plan's own figures ($1,668 at U95 3%, $2,350 at the 2.13% point estimate), the
setCategory calldata against `cast calldata`, and proposals against the two thresholds.

  cd oracle/validation && python3 -m unittest tests/test_report.py
"""

from __future__ import annotations

import json
import unittest
from fractions import Fraction

from gate.gate import GATE_FILE
from measure.measure import OUT as MEASURE_FILE
from report import report as R


class ReviewLimit(unittest.TestCase):
    def test_plan_figures(self):
        self.assertEqual(R.R_TR, Fraction(1, 43_800))  # 10%/year × 2 h
        self.assertEqual(R.usd(R.oi_review(300)), "$1,667.93")  # plan: $1,668 at U95 = 3%
        self.assertEqual(R.usd(R.oi_review(213)), "$2,349.93")  # plan: $2,350 at 2.13%
        self.assertEqual(R.oi_review(300), Fraction(50) / (Fraction(3, 100) - Fraction(1, 43_800)))

    def test_no_finite_limit_at_or_below_r_tr(self):
        self.assertIsNone(R.oi_review(0))
        self.assertIsNotNone(R.oi_review(1))  # 1 bp = 1/10,000 > 1/43,800

    def test_limit_atoms_floor(self):
        rep = R.build(json.loads(GATE_FILE.read_text()), {"categories": {"x": {"u95Bps": 300, "N": 10, "k": 0, "passes": False}}, "errorCorrelation": [], "watchdog": {}}, "c")
        self.assertEqual(rep["categories"]["x"]["reviewLimitAtoms"], str((R.oi_review(300) * 10**6).numerator // (R.oi_review(300) * 10**6).denominator))
        self.assertEqual(rep["categories"]["x"]["reviewLimitAtoms"], "1667936024")  # 50 × 43,800 / 1,313 = $1,667.936024… → atoms, floored


class Proposals(unittest.TestCase):
    def test_calldata_matches_cast(self):
        # cast calldata "setCategory(bytes32,bytes32,uint16,uint32,bool)" 0xaa.. 0xbb.. 198 150 true
        want = "0x96664816" + "aa" * 32 + "bb" * 32 + f"{198:064x}" + f"{150:064x}" + f"{1:064x}"
        self.assertEqual(R.set_category_calldata("0x" + "aa" * 32, "0x" + "bb" * 32, 198, 150), want)

    def test_only_categories_meeting_both_thresholds(self):
        gate = json.loads(GATE_FILE.read_text())
        cats = {"sports": (198, 150), "macro": (200, 149), "crypto": (201, 500), "elections": (100, 300), "politics": (10_000, 0)}
        measure = {"categories": {c: {"u95Bps": u, "N": n, "k": 0, "passes": u <= 200 and n >= 150} for c, (u, n) in cats.items()}, "errorCorrelation": [], "watchdog": {}}
        rep = R.build(gate, measure, "c")
        self.assertEqual([p["category"] for p in rep["proposals"]], ["sports", "elections"])
        for p in rep["proposals"]:
            g = gate["categories"][p["category"]]
            self.assertEqual(p["data"], R.set_category_calldata(g["categoryId"], g["gateHash"], *cats[p["category"]]))


class Committed(unittest.TestCase):
    def test_report_json_reproduces_and_proposes_only_passing_categories(self):
        committed = json.loads(R.OUT.read_text())
        rebuilt = R.build(json.loads(GATE_FILE.read_text()), json.loads(MEASURE_FILE.read_text()), committed["codeCommit"])
        self.assertEqual(rebuilt, committed)
        for p in committed["proposals"]:
            c = committed["categories"][p["category"]]
            self.assertTrue(c["u95Bps"] <= 200 and c["N"] >= 150)
        self.assertIn(committed["codeCommit"], R.DOC.read_text())


if __name__ == "__main__":
    unittest.main()
