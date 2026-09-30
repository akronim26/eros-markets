"""B006: all-prefix order admission reference.

The coverage port below is a scripted stand-in for Person A's order-aware endpoint deficits
(spec §7.3 formulas written inline for fixed fixtures). It is test data, not B logic.
"""
import itertools
import sys
import unittest
from fractions import Fraction as F
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from reference.b import margin as mg  # noqa: E402
from reference.b import order_admission as oa  # noqa: E402

Q = 10**18
U = 1000 * Q
USDC = 10**6 * Q
T29 = F(29 * 86400)


def scripted_port(reserve_q=100_000 * USDC, other_dbar=(0, 0), budget=0, cap_q=2_000 * USDC):
    def port(cash_q, x, s):
        c_eff = cash_q - s.fee_cap_q
        d0 = max(0, -(c_eff - s.bid_value_q))
        d1 = max(0, -(c_eff + U * x - U * s.ask_lots + s.ask_value_q))
        ok = reserve_q >= other_dbar[0] + d0 + budget and reserve_q >= other_dbar[1] + d1 + budget
        return oa.CoverageInput(d0, d1, cap_q, ok)
    return port


class DirectFiveX(unittest.TestCase):
    def setUp(self):
        self.kernel = oa.margin_kernel(6 * 10**17, T29, mg.fixture_profile(cap=5))

    def test_emin_and_admission(self):
        s = oa.add_order(oa.OrderSums(), True, 1_000_000, 600)
        self.assertEqual(oa.e_min_q(120 * USDC, 0, 6 * 10**17, s), 120 * USDC)
        im, full = oa.im_upper_q(0, s, self.kernel)
        self.assertEqual((im, full), (120 * USDC, False))
        ok, reason = oa.admit(120 * USDC, 0, 6 * 10**17, s, self.kernel, scripted_port())
        self.assertTrue(ok, reason)

    def test_rectangle_would_reject(self):
        s = oa.add_order(oa.OrderSums(), True, 1_000_000, 600)
        self.assertEqual(120 * USDC - s.bid_value_q, -480 * USDC)

    def test_reserve_too_small_rejects_same_margin(self):
        s = oa.add_order(oa.OrderSums(), True, 1_000_000, 600)
        ok, reason = oa.admit(120 * USDC, 0, 6 * 10**17, s, self.kernel, scripted_port(reserve_q=479 * USDC))
        self.assertEqual((ok, reason), (False, "RESERVE_COVERAGE"))

    def test_deficit_cap(self):
        s = oa.add_order(oa.OrderSums(), True, 1_000_000, 600)
        ok, reason = oa.admit(120 * USDC, 0, 6 * 10**17, s, self.kernel, scripted_port(cap_q=479 * USDC))
        self.assertEqual((ok, reason), (False, "DEFICIT_CAP"))

    def test_halving_cap(self):
        cap, steps, _ = oa.safe_taker_cap(2_000_000, True, 600, 0, 120 * USDC, 0, 6 * 10**17,
                                          oa.OrderSums(), self.kernel, scripted_port())
        self.assertEqual((cap, steps), (1_000_000, 1))

    def test_stale_price(self):
        s = oa.add_order(oa.OrderSums(), True, 10, 600)
        self.assertEqual(oa.admit(120 * USDC, 0, None, s, None, scripted_port()), (False, "STALE_PRICE"))


class ExactFullBacking(unittest.TestCase):
    def test_exact_1x_bid(self):
        k = oa.margin_kernel(6 * 10**17, T29, mg.fixture_profile(cap=1))
        fee_cap = 7 * Q
        s = oa.add_order(oa.OrderSums(), True, 1000, 650, fee_cap)
        exact = 1000 * 650 * Q + fee_cap
        self.assertEqual(oa.admit(exact, 0, 6 * 10**17, s, k, scripted_port()), (True, "NONE"))
        self.assertEqual(oa.admit(exact - 1, 0, 6 * 10**17, s, k, scripted_port()), (False, "INSUFFICIENT_IM"))

    def test_oversized_ask_rejected_at_1x(self):
        k = oa.margin_kernel(55 * 10**16, T29, mg.fixture_profile(cap=1))
        s = oa.add_order(oa.OrderSums(), False, 2300, 550)
        ok, _ = oa.admit(0, 1000, 55 * 10**16, s, k, scripted_port())
        self.assertFalse(ok)
        d1 = scripted_port()(0, 1000, s).d1_q
        self.assertEqual(d1, 35_000 * Q)


class Reservations(unittest.TestCase):
    def test_cancel_uses_tick(self):
        s = oa.add_order(oa.add_order(oa.OrderSums(), True, 7, 400), True, 11, 600)
        s = oa.remove_order(s, True, 7, 400)
        self.assertEqual((s.bid_lots, s.bid_value_q), (11, 6600 * Q))
        self.assertEqual(s.max_bid_tick, 600)

    def test_extrema_stay_pessimistic(self):
        s = oa.add_order(oa.add_order(oa.OrderSums(), True, 5, 700), True, 5, 300)
        s = oa.remove_order(s, True, 5, 700)
        self.assertEqual(s.max_bid_tick, 700)

    def test_underflow_is_error(self):
        s = oa.add_order(oa.OrderSums(), True, 5, 300)
        with self.assertRaises(AssertionError):
            oa.remove_order(s, True, 6, 300)
        with self.assertRaises(AssertionError):
            oa.remove_order(s, True, 5, 400)  # wrong tick attribution

    def test_reduce_only_cap(self):
        self.assertEqual(oa.reduce_only_cap(3, False, 10), 3)
        self.assertEqual(oa.reduce_only_cap(3, True, 10), 0)
        self.assertEqual(oa.reduce_only_cap(0, False, 10), 0)
        self.assertEqual(oa.reduce_only_cap(-4, True, 10), 4)


def mixtures(orders):
    """Every fill vector (f_i in 0..lots_i) over the listed orders."""
    return itertools.product(*[range(o[1] + 1) for o in orders])


def apply_fills(cash_q, x, orders, fills):
    for (is_bid, lots, tick), f in zip(orders, fills):
        if is_bid:
            x += f
            cash_q -= f * tick * Q
        else:
            x -= f
            cash_q += f * tick * Q
    return cash_q, x


class Enumeration(unittest.TestCase):
    """Small-state enumeration: every admitted commitment set is safe for every fill mixture."""

    Q_WAD = 6 * 10**17

    def kernel(self):
        return oa.margin_kernel(self.Q_WAD, F(3600), mg.fixture_profile(cap=5))

    def check_state(self, cash_q, x, orders, kernel, certified=True):
        s = oa.OrderSums()
        for is_bid, lots, tick in orders:
            s = oa.add_order(s, is_bid, lots, tick)
        ok, _ = oa.admit(cash_q, x, self.Q_WAD, s, kernel, scripted_port(), certified)
        emin = oa.e_min_q(cash_q, x, self.Q_WAD, s)
        worst_gap = None
        for fills in mixtures(orders):
            c2, x2 = apply_fills(cash_q, x, orders, fills)
            e2 = c2 + x2 * 1000 * self.Q_WAD
            self.assertGreaterEqual(e2, emin, "Emin is a lower bound over all mixtures")
            im2, full2 = kernel(abs(x2), x2 > 0)
            gap = e2 - im2
            if full2:
                gap = min(c2, c2 + U * x2)
            worst_gap = gap if worst_gap is None else min(worst_gap, gap)
        return ok, worst_gap

    def test_all_admitted_states_are_safe(self):
        kernel = self.kernel()
        books = [
            [(True, 3, 620), (False, 2, 580)],
            [(True, 4, 590), (True, 2, 640)],
            [(False, 4, 610), (False, 3, 560), (True, 1, 600)],
            [(False, 6, 600)],                     # sign flip from a small long
        ]
        admitted = 0
        for orders in books:
            for x in (-3, 0, 2, 5):
                for cash_units in range(-4000, 6001, 250):
                    cash_q = cash_units * Q
                    ok, worst = self.check_state(cash_q, x, orders, kernel)
                    if ok:
                        admitted += 1
                        self.assertGreaterEqual(worst, 0, (orders, x, cash_units))
        self.assertGreater(admitted, 20)

    def test_accepted_taker_prefixes_are_safe(self):
        kernel = self.kernel()
        resting = [(False, 3, 610)]
        s = oa.add_order(oa.OrderSums(), False, 3, 610)
        admitted = 0
        for cash_units in range(0, 4001, 400):
            cap, _, _ = oa.safe_taker_cap(12, True, 650, 0, cash_units * Q, 1, self.Q_WAD, s,
                                          kernel, scripted_port())
            if cap == 0:
                continue  # nothing admitted: no prefix is claimed safe
            admitted += 1
            for prefix in range(0, cap + 1):
                orders = resting + ([(True, prefix, 650)] if prefix else [])
                for fills in mixtures(orders):
                    c2, x2 = apply_fills(cash_units * Q, 1, orders, fills)
                    im2, full2 = kernel(abs(x2), x2 > 0)
                    e2 = c2 + x2 * 1000 * self.Q_WAD
                    self.assertGreaterEqual(min(c2, c2 + U * x2) if full2 else e2 - im2, 0)
        self.assertGreaterEqual(admitted, 5)

    def test_interior_hump_needs_envelope(self):
        # Synthetic nonmonotone kernel: IM peaks at 5 lots and is small at 0 and 10 lots.
        def hump(n, is_long):
            return ((5000 if n == 5 else 10) * Q if n else 0), False
        orders = [(True, 10, 600)]
        s = oa.add_order(oa.OrderSums(), True, 10, 600)
        cash_q = 1000 * Q
        endpoint_only, _ = oa.admit(cash_q, 0, self.Q_WAD, s, hump, scripted_port(), certified_monotone=True)
        certified, _ = oa.admit(cash_q, 0, self.Q_WAD, s, hump, scripted_port(), certified_monotone=False)
        self.assertTrue(endpoint_only, "endpoint-only evaluation is fooled by the hump")
        self.assertFalse(certified, "generic certified envelope catches the interior hump")
        _, worst = self.check_state(cash_q, 0, orders, hump, certified=True)
        self.assertLess(worst, 0, "the enumeration exhibits the unsafe interior prefix")

    def test_sign_flip_uses_opposite_side(self):
        # Long 2 lots posts an ask of 12: reachable inventory reaches -10, evaluated on the short side.
        calls = []

        def spy(n, is_long):
            calls.append((n, is_long))
            return (10**9 * Q if not is_long and n >= 10 else 0), False
        s = oa.add_order(oa.OrderSums(), False, 12, 600)
        ok, _ = oa.admit(10**6 * Q, 2, self.Q_WAD, s, spy, scripted_port())
        self.assertFalse(ok)
        self.assertIn((10, False), calls)
        self.assertIn((2, True), calls)


if __name__ == "__main__":
    unittest.main()
