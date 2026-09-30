"""B005: margin, health and template reference."""
import json
import sys
import unittest
from dataclasses import replace
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from reference.b import horizon_volatility as hv  # noqa: E402
from reference.b import margin as mg  # noqa: E402

GOLD = {c["id"]: c for c in json.loads((ROOT / "reference/fixtures/golden_cases.json").read_text())["cases"]}
Q = 10**18
T29 = F(29 * 86400)


class DirectLeverageFixture(unittest.TestCase):
    def setUp(self):
        self.p = mg.fixture_profile(cap=5)

    def test_long_im_120(self):
        r = mg.side_margin(F(1000), True, F(6, 10), T29, self.p)
        g = GOLD["G07_direct5x_long_29d"]["expected"]
        self.assertFalse(r.full_backing)
        self.assertEqual(r.im_hi, 120)
        self.assertEqual(r.im_lo, 120)
        self.assertGreaterEqual(r.mm_lo, F(g["MM_usdc"]["lo"]))
        self.assertLessEqual(r.mm_hi, F(g["MM_usdc"]["hi"]))
        self.assertEqual(r.worst_loss, 600)

    def test_short_im_about_95894(self):
        r = mg.side_margin(F(1000), False, F(6, 10), T29, self.p)
        g = GOLD["G08_short_100_vs_80"]["expected"]
        self.assertGreaterEqual(r.im_lo, F(g["IM_usdc"]["lo"]))
        self.assertLessEqual(r.im_hi, F(g["IM_usdc"]["hi"]))
        self.assertTrue(F("95.893") < r.im_hi < F("95.894"))

    def test_short_collateral_80_fails_100_passes(self):
        # Bob: deposits collateral, sells 1,000 claims at 0.60: cash = collateral + 600 USDC.
        for collateral, ok in [(80, False), (100, True)]:
            cash = (collateral + 600) * 10**6 * Q
            h = mg.health(cash, -1_000_000, 6 * 10**17, T29, self.p)
            self.assertEqual(h.mark_equity_q, collateral * 10**6 * Q)
            self.assertEqual(h.mark_equity_q >= h.im_q, ok, collateral)

    def test_long_with_120_passes_and_leverage_5x(self):
        cash = -480 * 10**6 * Q
        h = mg.health(cash, 1_000_000, 6 * 10**17, T29, self.p)
        self.assertEqual(h.status, "HEALTHY")
        self.assertEqual(h.im_q, 120 * 10**6 * Q)
        exposure = 1_000_000 * 1000 * 6 * 10**17
        self.assertEqual(mg.display_leverage_bps(exposure, h.mark_equity_q), 50_000)


class FullBackingAndCaps(unittest.TestCase):
    def test_missing_calibration_is_1x(self):
        p = mg.fixture_profile(cap=5, calibrated=False)
        r = mg.side_margin(F(1000), True, F(6, 10), T29, p)
        self.assertTrue(r.full_backing)
        self.assertEqual((r.cap, r.im_hi, r.mm_hi), (1, 600, 600))
        self.assertEqual(mg.to_q_up(r.im_hi), int(GOLD["G09_missing_calibration_is_1x"]["expected"]["IM_Q"]))

    def test_expired_envelope_is_full_backing(self):
        p = replace(mg.fixture_profile(cap=5), realized=hv.Envelope(((10**12, F(0)),), 0, 10), now=10)
        r = mg.side_margin(F(1000), True, F(6, 10), T29, p)
        self.assertTrue(r.full_backing)
        self.assertEqual(r.reason, "missing/expired calibration")

    def test_initial_deployment_cap_1(self):
        r = mg.side_margin(F(1000), True, F(6, 10), T29, mg.fixture_profile(cap=1))
        self.assertTrue(r.full_backing)
        self.assertEqual(r.im_hi, r.worst_loss)

    def test_template_caps(self):
        self.assertEqual(mg.directional_cap("SCHEDULED", True, True, 99), 5)
        self.assertEqual(mg.directional_cap("CONTINUOUS", False, True, 99), 3)
        self.assertEqual(mg.directional_cap("DEADLINE", True, True, 99), 3)
        self.assertEqual(mg.directional_cap("DEADLINE", False, True, 99), 1)
        self.assertEqual(mg.directional_cap("UNSCHEDULED", True, True, 99), 1)
        self.assertEqual(mg.directional_cap("SCHEDULED", True, True, 1), 1)
        self.assertEqual(mg.directional_cap("SCHEDULED", True, False, 5), 1)

    def test_hazard_domain_failure(self):
        p = replace(mg.fixture_profile(cap=5), hazard0_per_day=F(100))
        r = mg.side_margin(F(1000), True, F(6, 10), T29, p)
        self.assertTrue(r.full_backing)
        # a short is not adverse to NO jumps, but a0 alone makes a0 + a1 >= 1 here
        self.assertTrue(mg.side_margin(F(1000), False, F(6, 10), T29, p).full_backing)

    def test_full_backing_health_uses_exact_endpoints(self):
        p = mg.fixture_profile(cap=1)
        # long 1 claim with cash 0: E0 = 0 exactly is healthy; one Q less is not
        h = mg.health(0, 1000, 6 * 10**17, T29, p)
        self.assertEqual(h.status, "HEALTHY")
        h = mg.health(-1, 1000, 6 * 10**17, T29, p)
        self.assertEqual(h.status, "BELOW_MM")


class ZeroAndNegative(unittest.TestCase):
    def test_flat_is_zero_margin(self):
        r = mg.side_margin(F(0), True, F(6, 10), T29, mg.fixture_profile())
        self.assertEqual((r.mm_hi, r.im_hi, r.full_backing), (0, 0, False))
        h = mg.health(5 * Q, 0, 6 * 10**17, T29, mg.fixture_profile())
        self.assertEqual((h.status, h.mm_q, h.im_q), ("FLAT", 0, 0))

    def test_zero_and_negative_equity(self):
        g = GOLD["G05_zero_equity_takeover"]["input"]
        h = mg.health(int(g["cash_Q"]), g["position_lots"], int(g["mark_wad"]), T29, mg.fixture_profile())
        self.assertEqual(h.status, "NONPOSITIVE")
        self.assertIsNone(mg.display_leverage_bps(10, 0))
        self.assertIsNone(mg.display_leverage_bps(10, -5))

    def test_below_mm_and_between(self):
        p = mg.fixture_profile()
        # long 1,000 claims at 0.6; MM ~63.93, IM 120
        for equity_usdc, status in [(130, "HEALTHY"), (100, "BELOW_IM"), (50, "BELOW_MM")]:
            cash = (equity_usdc - 600) * 10**6 * Q
            self.assertEqual(mg.health(cash, 1_000_000, 6 * 10**17, T29, p).status, status)


class Monotone(unittest.TestCase):
    def test_im_nondecreasing_in_size_both_signs(self):
        p = mg.fixture_profile()
        for q in [F(5, 100), F(6, 10), F(95, 100)]:
            for is_long in (True, False):
                prev_im, prev_full = F(0), False
                for lots in list(range(0, 3000, 37)) + [10**5, 10**6, 10**7, 5 * 10**7, 2**40]:
                    r = mg.side_margin(F(lots, 1000), is_long, q, T29, p)
                    self.assertGreaterEqual(r.im_hi, prev_im, (q, is_long, lots))
                    if prev_full:
                        self.assertTrue(r.full_backing, "full-backing switch is upward")
                    prev_im, prev_full = r.im_hi, r.full_backing

    def test_mm_nondecreasing_in_horizon_inputs(self):
        base = mg.fixture_profile()
        prev = F(0)
        for queue in [0, 10, 60, 600, 3600]:
            r = mg.side_margin(F(1000), True, F(6, 10), T29, replace(base, queue_secs=F(queue)))
            self.assertGreaterEqual(r.mm_hi, prev)
            prev = r.mm_hi

    def test_im_never_exceeds_worst_loss(self):
        p = mg.fixture_profile()
        for lots in [1, 10, 1000, 10**6, 10**8]:
            for is_long in (True, False):
                r = mg.side_margin(F(lots, 1000), is_long, F(3, 10), F(3600), p)
                self.assertLessEqual(r.im_hi, r.worst_loss)
                self.assertLessEqual(r.mm_hi, r.im_hi)


if __name__ == "__main__":
    unittest.main()
