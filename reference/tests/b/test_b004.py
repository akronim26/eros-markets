"""B004: hazard, tail and drift reference."""
import sys
import unittest
from fractions import Fraction as F
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from reference.b import hazards as hz  # noqa: E402

EPS = F(1, 100)


class Hazard(unittest.TestCase):
    def test_fixture_linear_bound(self):
        a = hz.hazard_upper(F(1, 10000), F(360))
        self.assertEqual(a, F(1, 10000) * 360 / 86400)
        self.assertEqual(a, F(1, 2400000))  # 4.1666...e-7

    def test_saturates_at_one(self):
        self.assertEqual(hz.hazard_upper(F(5), F(86400)), 1)

    def test_linear_bound_dominates_exponential(self):
        # 1 - exp(-z) <= z for z >= 0; checked with an alternating-series lower bound of exp(-z)
        # (exp(-z) >= 1 - z + z^2/2 - z^3/6) so 1 - exp(-z) <= z - z^2/2 + z^3/6 <= z for z <= 1.
        for z in [F(0), F(1, 10**6), F(1, 100), F(1, 2), F(1)]:
            upper_of_source = z - z * z / 2 + z**3 / 6
            self.assertLessEqual(upper_of_source, hz.hazard_upper(z, F(86400)))

    def test_negative_rejected(self):
        with self.assertRaises(ValueError):
            hz.hazard_upper(F(-1), F(1))


class Tail(unittest.TestCase):
    def test_fixture_k(self):
        a = F(1, 2400000)
        r = hz.tail(a, a, True, EPS)
        self.assertFalse(r.full_backing)
        self.assertEqual(r.eps_prime, (EPS - a) / (1 - a))
        lo, hi = r.k
        # spec: Cantelli multiplier about 9.95008
        self.assertTrue(F("9.950081666") < lo <= hi < F("9.950081667"))
        target = (1 - r.eps_prime) / r.eps_prime
        self.assertLessEqual(lo * lo, target)
        self.assertGreaterEqual(hi * hi, target)

    def test_adverse_at_epsilon_forces_full_backing(self):
        r = hz.tail(EPS, F(0), True, EPS)
        self.assertTrue(r.full_backing)
        self.assertEqual(r.reason, "a_adv>=epsilon")
        # same a0 for a short is not adverse
        self.assertFalse(hz.tail(EPS, F(0), False, EPS).full_backing)

    def test_exhausted_denominator(self):
        for a0, a1 in [(F(1, 2), F(1, 2)), (F(1), F(0)), (F(3, 4), F(1, 2))]:
            r = hz.tail(a0, a1, True, EPS)
            self.assertTrue(r.full_backing)
            self.assertEqual(r.reason, "a0+a1>=1")

    def test_direction_swap(self):
        a0, a1 = F(1, 1000), F(5, 1000)
        long_r, short_r = hz.tail(a0, a1, True, EPS), hz.tail(a0, a1, False, EPS)
        self.assertEqual(long_r.a_adv, a0)
        self.assertEqual(short_r.a_adv, a1)
        self.assertGreater(short_r.k[0], long_r.k[1])  # larger adverse hazard -> larger k

    def test_k_increases_with_adverse_hazard(self):
        prev = None
        for n in range(0, 100):
            a = F(n, 10**4)
            r = hz.tail(a, F(0), True, EPS)
            if r.full_backing:
                self.assertGreaterEqual(a, EPS)
                break
            if prev is not None:
                self.assertGreaterEqual(r.k[1], prev)
            prev = r.k[1]


class Drift(unittest.TestCase):
    def test_formulas(self):
        q, a0, a1 = F(6, 10), F(1, 1000), F(2, 1000)
        self.assertEqual(hz.adverse_drift(q, a0, a1, True), F(4, 10) * a1 / (1 - a0 - a1))
        self.assertEqual(hz.adverse_drift(q, a0, a1, False), q * a0 / (1 - a0 - a1))

    def test_no_favorable_term_understates_drift(self):
        for q in [F(1, 100), F(3, 10), F(1, 2), F(9, 10), F(99, 100)]:
            for a0, a1 in [(F(1, 1000), F(2, 1000)), (F(5, 100), F(1, 100)), (F(0), F(1, 10))]:
                for is_long in (True, False):
                    ours = hz.adverse_drift(q, a0, a1, is_long)
                    source = hz.source_conditional_drift(q, a0, a1, is_long)
                    self.assertGreaterEqual(ours, source)
                    self.assertGreaterEqual(ours, 0)

    def test_exhausted(self):
        self.assertIsNone(hz.adverse_drift(F(1, 2), F(1, 2), F(1, 2), True))


if __name__ == "__main__":
    unittest.main()
