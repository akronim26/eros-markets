"""Task O39.4: calibration maps (plan §8.3, §10 step 3).

Isotonic fits checked on hand-made points (monotone, clipped, rounded down, grouped by parent, placeholder when thin);
calibratorHash checked against the panel runner's own computation (a vector it produced with bun, and the committed
maps.json hashed by the panel runner when bun is available).

  cd oracle/validation && python3 -m unittest tests/test_calibration.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from fractions import Fraction as F
from pathlib import Path

from gate import calibrate as C
from gate.gate import GATE_FILE, MAPS_FILE, MODELS

from .fixtures_runs import rec

PANEL_RUNNER = Path(__file__).resolve().parents[2] / "services" / "panel-runner"


def answers(model_conf_ok: list[tuple[str, bool, str]]):
    """One calibration record per (confidence, correct, parent) for the first model; the others NOT_YET."""
    out = []
    for i, (c, ok, parent) in enumerate(model_conf_ok):
        out.append(rec("calibration", "sports", parent, f"m{i}", "YES" if ok else "NO", ["YES", "NOT_YET", "NOT_YET"], [c, "0.5", "0.5"]))
    return out


class Fit(unittest.TestCase):
    def test_placeholder_below_min_parents(self):
        recs = answers([("0.9", True, f"p{i}") for i in range(C.MIN_PARENTS - 1)])
        self.assertEqual(C.fit(recs, MODELS[0])["breakpoints"], [[F(0), F(49, 100)], [F(1), F(49, 100)]])
        self.assertEqual(C.fit(recs, MODELS[1])["breakpoints"], [[F(0), F(49, 100)], [F(1), F(49, 100)]])  # no known answers

    def test_isotonic_monotone_and_pooled(self):
        # 40 parents: low confidences mostly wrong, high mostly right, with a violation at 0.8 that must be pooled
        pts = [("0.6", False, f"a{i}") for i in range(10)] + [("0.7", i < 6, f"b{i}") for i in range(10)]
        pts += [("0.8", i < 4, f"c{i}") for i in range(10)] + [("0.95", i < 9, f"d{i}") for i in range(10)]
        m = C.fit(answers(pts), MODELS[0])
        ys = [g for _, g in m["breakpoints"]]
        xs = [c for c, _ in m["breakpoints"]]
        self.assertEqual(ys, sorted(ys))
        self.assertEqual(xs, sorted(set(xs)))
        # 0.7 (6/10) and 0.8 (4/10) violate and pool to 1/2; 0.6 is 0, clipped to 0.01; 0.95 is 9/10
        self.assertEqual(m["breakpoints"], [[F(6, 10), F(1, 100)], [F(7, 10), F(1, 2)], [F(8, 10), F(1, 2)], [F(95, 100), F(9, 10)]])

    def test_clip_and_round_down(self):
        pts = [("0.99", True, f"p{i}") for i in range(30)] + [("0.5", i < 1, f"q{i}") for i in range(3)]
        m = C.fit(answers(pts), MODELS[0])
        self.assertEqual(m["breakpoints"][-1][1], F(99, 100))  # 30/30 right, clipped to 0.99
        self.assertEqual(m["breakpoints"][0][1], F(3333, 10_000))  # 1/3 rounded down

    def test_grouped_by_parent(self):
        # one parent with 20 right answers at 0.9 weighs as much as one parent with 1 wrong answer at 0.9
        pts = [("0.9", True, "big")] * 20 + [("0.9", False, "small")] + [("0.5", False, f"z{i}") for i in range(30)]
        m = C.fit(answers(pts), MODELS[0])
        self.assertEqual(C.apply(m, F(9, 10)), F(1, 2))

    def test_calibrated_bps_exact(self):
        m = {"model": MODELS[0], "breakpoints": [[F(0), F(1, 100)], [F(1), F(99, 100)]]}
        self.assertEqual(C.calibrated_bps(m, F(29, 100)), 2942)  # 0.01 + 0.98 × 0.29 = 0.2942 exactly, not 2941
        self.assertEqual(C.calibrated_bps(m, F(0)), 100)
        self.assertEqual(C.calibrated_bps({"model": "x", "breakpoints": [[F(0), F(0)], [F(1), F(1)]]}, F(1)), 9900)


class Hash(unittest.TestCase):
    def test_matches_the_panel_runner_vector(self):
        # bun, panel-runner calibratorHash of exactly these three maps (4 Oct 2026)
        maps = [
            {"model": "groq:x@1", "breakpoints": [[F(1, 10), F(1, 100)], [F(1, 2), F(123, 10_000)], [F(95, 100), F(99, 100)]]},
            {"model": "nvidia:y@1", "breakpoints": [[F(0), F(3, 10)], [F(1), F(9, 10)]]},
            {"model": "aicredits:google/gemini-3.8-flash@2026-10-04", "breakpoints": [[F(0), F(49, 100)], [F(1), F(49, 100)]]},
        ]
        self.assertEqual(C.calibrator_hash(maps), "0x44330d86c991afd31f507daa519d1dab17ac541eed3310f723b365e82ed61a50")
        self.assertEqual(C.es_number(F(123, 10_000)), "0.0123")
        self.assertEqual([C.es_number(F(0)), C.es_number(F(1)), C.es_number(F(1, 2))], ["0", "1", "0.5"])

    def test_committed_maps(self):
        maps = C.loads_maps(MAPS_FILE.read_text())
        self.assertEqual([m["model"] for m in maps], list(MODELS))
        gate = json.loads(GATE_FILE.read_text())
        self.assertEqual(C.calibrator_hash(maps), gate["calibration"]["calibratorHash"])
        for m in maps:
            b = m["breakpoints"]
            self.assertGreaterEqual(len(b), 2)
            self.assertTrue(all(b[i][0] < b[i + 1][0] and b[i][1] <= b[i + 1][1] for i in range(len(b) - 1)))
            self.assertTrue(all(F(1, 100) <= g <= F(99, 100) for _, g in b))

    @unittest.skipUnless(shutil.which("bun") and (PANEL_RUNNER / "node_modules").exists(), "bun and the panel runner's install")
    def test_committed_maps_hash_in_the_panel_runner(self):
        script = f"import {{ calibratorHash, checkMap }} from './src/calibration'; const m = JSON.parse(require('fs').readFileSync({json.dumps(str(MAPS_FILE))}, 'utf8')); m.forEach(checkMap); console.log(calibratorHash(m))"
        out = subprocess.run(["bun", "--no-env-file", "-e", script], cwd=PANEL_RUNNER, capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(out, json.loads(GATE_FILE.read_text())["calibration"]["calibratorHash"])


if __name__ == "__main__":
    unittest.main()
