"""B008: liquidation decision reference."""
import inspect
import json
import sys
import unittest
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from reference.b import liquidation as lq  # noqa: E402
from reference.b import margin as mg  # noqa: E402

GOLD = {c["id"]: c for c in json.loads((ROOT / "reference/fixtures/golden_cases.json").read_text())["cases"]}
Q = 10**18
USDC = 10**6 * Q
T29 = F(29 * 86400)
QW = 6 * 10**17
P = mg.fixture_profile(cap=5)


class Takeover(unittest.TestCase):
    def test_signature_has_no_work_budget(self):
        params = set(inspect.signature(lq.authorize_takeover).parameters)
        for banned in ("max_lots", "max_examinations", "budget", "liquidity"):
            self.assertNotIn(banned, params)

    def test_zero_equity_takeover(self):
        g = GOLD["G05_zero_equity_takeover"]["input"]
        h = mg.health(int(g["cash_Q"]), g["position_lots"], int(g["mark_wad"]), T29, P)
        self.assertTrue(lq.authorize_takeover(True, False, h.e0_q, h.e1_q, h.mark_equity_q))
        r = lq.book_close(int(g["cash_Q"]), g["position_lots"], QW, T29, P, [(600, 10**7)], 10, 10, 10**9)
        self.assertEqual(r.status, "TAKEOVER_AUTHORIZED")

    def test_positive_equity_small_budget_no_takeover(self):
        g = GOLD["G19_small_budget_no_takeover"]
        cash = -540 * USDC  # E = 60 USDC < MM ~63.93
        r = lq.book_close(cash, 1_000_000, QW, T29, P, [(600, 10**7)], max_lots=1, max_examinations=64,
                          block_budget_lots=10**9)
        self.assertEqual(r.status, g["expected"]["result"])
        self.assertEqual(sum(f[1] for f in r.fills), 1)
        h = mg.health(r.cash_q, r.x_lots, QW, T29, P)
        self.assertFalse(lq.authorize_takeover(True, False, h.e0_q, h.e1_q, h.mark_equity_q))

    def test_empty_book_needs_more_work(self):
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [], 10**6, 64, 10**9)
        self.assertEqual((r.status, r.x_lots), ("NEEDS_MORE_WORK", 1_000_000))

    def test_stale_price_positive_equity_not_eligible(self):
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(600, 10**7)], 10**6, 64, 10**9, price_fresh=False)
        self.assertEqual(r.status, "NOT_ELIGIBLE")

    def test_floor_endpoint_deficit_is_price_free_takeover(self):
        self.assertTrue(lq.authorize_takeover(False, True, -1, 5, None))
        self.assertEqual(lq.eligibility(False, True, False, -1, 5, None, None, None), "TAKEOVER")
        self.assertFalse(lq.authorize_takeover(False, False, -1, 5, None))

    def test_both_endpoints_nonpositive(self):
        self.assertTrue(lq.authorize_takeover(False, False, -3, 0, None))
        self.assertFalse(lq.authorize_takeover(False, False, 0, 0, None))

    def test_zero_budget_rejected(self):
        with self.assertRaises(ValueError):
            lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(600, 10)], 0, 64, 10**9)
        with self.assertRaises(ValueError):
            lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(600, 10)], 10, 0, 10**9)

    def test_missing_block_cap_disables_forced_book(self):
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(600, 10**7)], 10**6, 64, None)
        self.assertEqual(r.status, "DISABLED")


class Eligibility(unittest.TestCase):
    def test_grace(self):
        # between MM and IM: eligible only after grace
        self.assertEqual(lq.eligibility(True, False, False, 1, 1, 100, 60, 120), "NONE")
        self.assertEqual(lq.eligibility(True, False, True, 1, 1, 100, 60, 120), "REDUCE")
        self.assertEqual(lq.eligibility(True, False, False, 1, 1, 50, 60, 120), "REDUCE")
        self.assertEqual(lq.eligibility(True, False, True, 1, 1, 130, 60, 120), "NONE")


class BookClose(unittest.TestCase):
    def test_restores_health_with_rechecked_fills(self):
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(600, 10**7)], 10**7, 64, 10**9)
        self.assertEqual(r.status, "DONE")
        self.assertEqual(mg.health(r.cash_q, r.x_lots, QW, T29, P).status, "HEALTHY")
        self.assertGreater(r.x_lots, 0, "partial reduction, no sign flip")
        # each fill: one atom per lot fee here, both deficits nonincreasing
        for tick, n, fee in r.fills:
            self.assertLessEqual(fee, n * Q)
        self.assertEqual(sum(n for _, n, _ in r.fills), 1_000_000 - r.x_lots)

    def test_every_fill_satisfies_predicate(self):
        levels = [(600, 100_000)] * 20
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, levels, 10**7, 64, 10**9)
        cash, x = -540 * USDC, 1_000_000
        for tick, n, fee in r.fills:
            before = lq.snap(cash, x, QW, T29, P)
            cash, x = cash + n * tick * Q - fee, x - n
            self.assertTrue(lq.allowed_reduction(before, lq.snap(cash, x, QW, T29, P)))

    def test_bad_price_levels_stop(self):
        # bids far below the bankruptcy tick are not hit
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(100, 10**7)], 10**7, 64, 10**9)
        self.assertEqual((r.status, r.fills), ("NEEDS_MORE_WORK", []))

    def test_examination_cap(self):
        levels = [(600, 1)] * 10
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, levels, 10**7, 3, 10**9)
        self.assertEqual((r.examined, r.status), (3, "NEEDS_MORE_WORK"))

    def test_block_pacing(self):
        r = lq.book_close(-540 * USDC, 1_000_000, QW, T29, P, [(600, 10**7)], 10**7, 64, 1000)
        self.assertEqual(sum(n for _, n, _ in r.fills), 1000)
        self.assertEqual(r.status, "NEEDS_MORE_WORK")


class Estimate(unittest.TestCase):
    def test_worked_estimate(self):
        h = mg.health(-540 * USDC, 1_000_000, QW, T29, P)
        n, full = lq.size_estimate_lots(h.im_q, h.mark_equity_q, 1_000_000, P.s, P.lam)
        self.assertFalse(full)
        # g = 60, D = 115, disc = 13105 -> delta = 120000/(115 + sqrt(13105)) ~= 522.93 claims
        self.assertTrue(522_900 <= n <= 523_000)

    def test_invalid_roots_full_close(self):
        self.assertEqual(lq.size_estimate_lots(100 * USDC, 150 * USDC, 1000, P.s, P.lam), (1000, True))  # g <= 0
        self.assertEqual(lq.size_estimate_lots(1 * USDC, 0, 10**6, F(1, 100), P.lam), (10**6, True))     # D <= 0
        self.assertEqual(lq.size_estimate_lots(100 * USDC, 0, 10**6, F(0), F(1)), (10**6, True))          # disc < 0

    def test_flat(self):
        self.assertEqual(lq.size_estimate_lots(0, 0, 0, P.s, P.lam), (0, False))


class Bankruptcy(unittest.TestCase):
    def test_golden_long(self):
        g = GOLD["G18_bankruptcy_tick_long"]["input"]
        t, ok = lq.bankruptcy_tick(g["position_lots"], g["close_lots"], int(g["cash_Q"]), int(g["q_wad"]),
                                   int(g["fee_Q"]), int(g["threshold_Q"]))
        self.assertEqual((t, ok), (541, True))

    def test_short_mirror(self):
        # short 1,000 claims, cash 640 USDC, buy all back with 1 USDC fee: 640 - t - 1 >= 0 -> t <= 639
        t, ok = lq.bankruptcy_tick(-1_000_000, 1_000_000, 640 * USDC, QW, 1 * USDC, 0)
        self.assertEqual((t, ok), (639, True))

    def test_partial_close_uses_remaining_mark(self):
        # long 2 claims, cash -1.1 USDC, sell 1 claim, remaining 1 claim marked at 0.6
        t, ok = lq.bankruptcy_tick(2000, 1000, -11 * 10**5 * Q, QW, 0, 0)
        # -1.1 + t/1000*1 + 0.6 >= 0 -> t >= 500
        self.assertEqual((t, ok), (500, True))

    def test_infeasible(self):
        self.assertEqual(lq.bankruptcy_tick(1000, 1000, -2 * USDC, QW, 0, 0), (None, False))

    def test_fee_waiver(self):
        before = lq.Snap(1000, 10, 10, 100, 50)
        after = lq.Snap(500, 10, 10, 60, 20)
        self.assertEqual(lq.fee_allowed_q(500, before, after, 55), 5)
        self.assertEqual(lq.fee_allowed_q(500, before, after, 60), 0)
        self.assertEqual(lq.fee_allowed_q(3, before, lq.Snap(500, 10**30, 10**30, 10**30, 0), 0), 3 * Q)


class Predicate(unittest.TestCase):
    def test_rules(self):
        b = lq.Snap(10, -5, 20, 30, 20)
        self.assertTrue(lq.allowed_reduction(b, lq.Snap(5, -5, 10, 28, 10)))
        self.assertFalse(lq.allowed_reduction(b, lq.Snap(10, -5, 10, 28, 10)))   # not smaller
        self.assertFalse(lq.allowed_reduction(b, lq.Snap(-2, -5, 10, 28, 10)))   # flips side
        self.assertFalse(lq.allowed_reduction(b, lq.Snap(5, -6, 10, 28, 10)))    # NO deficit grew
        self.assertFalse(lq.allowed_reduction(b, lq.Snap(5, -5, 10, -1, 0)))     # negative equity
        self.assertFalse(lq.allowed_reduction(b, lq.Snap(5, -5, 10, 15, 16)))    # worse than min(E-MM, 0)
        self.assertFalse(lq.allowed_reduction(lq.Snap(10, 0, 0, 0, 5), lq.Snap(5, 0, 0, 0, 1)))  # E <= 0 start


if __name__ == "__main__":
    unittest.main()
