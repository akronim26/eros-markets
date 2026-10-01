"""G1: combined reference trace over Person A + Person B reference engines (no placeholder port).
Expected values are hand-derived from the spec fixture, independent of both engines."""
import unittest
from fractions import Fraction as F

from reference.integration.combined_trace import run

Q = 10**18
USDC = 10**6 * Q


class CombinedTrace(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run()

    def test_admission_with_real_a_coverage(self):
        self.assertEqual(tuple(self.o["admit_alice"]), (True, "NONE"))

    def test_fill_and_deficits(self):
        self.assertEqual(self.o["after_fill"], (-480 * USDC, 1_000_000, 1000 * USDC, -1_000_000, 0))
        self.assertEqual(self.o["deficits"], (480 * USDC, 0, 0, 0))
        self.assertEqual(self.o["slacks_after_fill"], (99_520 * USDC, 100_000 * USDC))

    def test_margin_im_is_120(self):
        status, im, mm, em = self.o["alice_health"]
        self.assertEqual((status, im, em), ("HEALTHY", 120 * USDC, 120 * USDC))
        self.assertLess(mm, 80 * USDC)

    def test_funding_rate_and_zero_sum(self):
        r = (F(2, 100) * 1000 * Q / 86400).__trunc__()  # trunc toward zero
        self.assertEqual(self.o["rate"], r)
        index, alice_paid, bob_paid, cushion, clearing = self.o["funding"]
        self.assertEqual(index, r * 600)
        self.assertEqual(alice_paid, 1_000_000 * r * 600)
        self.assertEqual(bob_paid, -alice_paid)
        self.assertEqual((cushion, clearing), (0, 0))

    def test_premium_neutral_touch_and_value(self):
        first, second, single = self.o["premium"]
        self.assertEqual(first + second, single)
        r = self.o["rate"]
        integral = F(480 * USDC) * 600 + F(1_000_000 * r) * 600 * 600 / 2  # NO deficit grows by funding
        exact = integral * F(10**14, Q) * 2 * 4 / 86400
        self.assertEqual(single, -(-exact.numerator // exact.denominator))

    def test_liquidation_decisions(self):
        self.assertEqual(self.o["liq_050"], "REDUCE")
        self.assertTrue(self.o["takeover_048"])
        self.assertFalse(self.o["takeover_stale"])

    def test_terminal_payoff_conserves_assets(self):
        assets = self.o["assets_q"]
        self.assertEqual(assets, 100_520 * USDC)
        for label, (claims, lp_atoms, treasury_q) in self.o["payoff"].items():
            self.assertEqual(sum(claims) * Q + lp_atoms * Q + treasury_q, assets, label)
        self.assertEqual(self.o["payoff"]["NO"][0][0], 0)
        self.assertEqual(self.o["payoff"]["YES"][0][1], 138_888)  # Bob keeps his funding receipt


if __name__ == "__main__":
    unittest.main()
