"""B003: horizon and volatility reference."""
import sys
import unittest
from fractions import Fraction as F
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from reference.b import horizon_volatility as hv  # noqa: E402


class Horizon(unittest.TestCase):
    def test_fixture_horizon(self):
        # spec §7.9: h0 5 min, 1,000 claims at 1,000 claims/min => 6 min
        self.assertEqual(hv.horizon_exact(F(1000), F(300), F(1000)), 360)
        self.assertEqual(hv.horizon_secs_up(F(1000), 300, 1000), 360)

    def test_zero_size(self):
        self.assertEqual(hv.horizon_exact(F(0), F(300), F(1000)), 300)

    def test_large_size_and_rounding_up(self):
        max_claims = F(2**40, 1000)
        h = hv.horizon_exact(max_claims, F(300), F(1000))
        self.assertEqual(h, 300 + max_claims * 60 / 1000)
        self.assertGreaterEqual(hv.horizon_secs_up(max_claims, 300, 1000), h)
        self.assertEqual(hv.horizon_secs_up(F(1, 1000), 300, 1000), 301)  # 0.06 s rounds up

    def test_queue_delay_adds(self):
        self.assertEqual(hv.horizon_exact(F(1000), F(300), F(1000), F(45)), 405)

    def test_monotone_in_size(self):
        prev = None
        for lots in range(0, 5000, 7):
            h = hv.horizon_exact(F(lots, 1000), F(300), F(1000))
            if prev is not None:
                self.assertGreaterEqual(h, prev)
            prev = h

    def test_bad_units(self):
        with self.assertRaises(ValueError):
            hv.horizon_exact(F(1), F(300), F(0))
        with self.assertRaises(ValueError):
            hv.horizon_exact(F(-1), F(300), F(1000))


class Sigma(unittest.TestCase):
    def test_fixture_sigma_brackets(self):
        lo, hi = hv.sigma_theory(F(6, 10), F(360), F(29 * 86400))
        # spec: sigma = sqrt(.24*360/2505600) = .005872202195...
        self.assertLess(lo, F("0.0058722021952"))
        self.assertGreater(hi, F("0.0058722021951"))
        self.assertLessEqual(lo * lo, F(24, 100) * 360 / 2505600)
        self.assertGreaterEqual(hi * hi, F(24, 100) * 360 / 2505600)
        self.assertLess(hi - lo, F(1, 10**35))

    def test_near_t_uses_one_second_floor_and_caps_at_one(self):
        lo, hi = hv.sigma_theory(F(1, 2), F(360), F(0))
        self.assertEqual(hi, 1)  # sqrt(0.25*360/1) = 9.49 -> capped
        lo, hi = hv.sigma_theory(F(1, 2), F(1), F(1))
        self.assertEqual((lo, hi), (F(1, 2), F(1, 2)))

    def test_endpoint_price_unavailable(self):
        for q in (F(0), F(1)):
            with self.assertRaises(ValueError):
                hv.sigma_theory(q, F(360), F(1000))


class Envelope(unittest.TestCase):
    def env(self, bins, frm=0, until=10**9):
        return hv.Envelope(tuple((h, F(s)) for h, s in bins), frm, until)

    def test_step_up_never_interpolates_down(self):
        e = self.env([(60, "0.01"), (600, "0.02"), (3600, "0.05")])
        self.assertEqual(hv.envelope_at(e, F(1), 5), F("0.01"))
        self.assertEqual(hv.envelope_at(e, F(60), 5), F("0.01"))
        self.assertEqual(hv.envelope_at(e, F(61), 5), F("0.02"))
        self.assertEqual(hv.envelope_at(e, F(3600), 5), F("0.05"))
        self.assertIsNone(hv.envelope_at(e, F(3601), 5))  # beyond last bin: unavailable

    def test_noisy_decreasing_bins_rejected(self):
        e = self.env([(60, "0.03"), (600, "0.02"), (3600, "0.05")])
        with self.assertRaises(hv.CalibrationError):
            hv.envelope_at(e, F(100), 5)

    def test_conservative_conversion_is_running_max(self):
        e = hv.make_envelope([(600, F("0.02")), (60, F("0.03")), (3600, F("0.05"))], 0, 100)
        self.assertEqual([s for _, s in e.bins], [F("0.03"), F("0.03"), F("0.05")])
        raw = {60: F("0.03"), 600: F("0.02"), 3600: F("0.05")}
        for h, s in e.bins:
            self.assertGreaterEqual(s, raw[h])

    def test_missing_or_expired_calibration_unavailable(self):
        e = self.env([(60, "0.01")], frm=100, until=200)
        self.assertIsNone(hv.envelope_at(None, F(10), 150))
        self.assertIsNone(hv.envelope_at(e, F(10), 99))
        self.assertIsNone(hv.envelope_at(e, F(10), 200))
        self.assertEqual(hv.envelope_at(e, F(10), 199), F("0.01"))

    def test_sigma_upper(self):
        self.assertEqual(hv.sigma_upper(F("0.1"), F("0.2"), F("0.05")), F("0.2"))
        self.assertEqual(hv.sigma_upper(F("0.9"), F("3"), F(0)), 1)
        self.assertIsNone(hv.sigma_upper(F("0.1"), None, F(0)))


class SqrtBounds(unittest.TestCase):
    def test_brackets(self):
        for v in [F(2), F(1, 3), F(10**12 + 7), F(1, 10**30), F(0)]:
            lo, hi = hv.sqrt_bounds(v)
            self.assertLessEqual(lo * lo, v)
            self.assertGreaterEqual(hi * hi, v)
            self.assertLessEqual(hi - lo, F(2, hv.SQRT_SCALE))


if __name__ == "__main__":
    unittest.main()
