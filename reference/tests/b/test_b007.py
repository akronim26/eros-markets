"""B007: pure time-weighted pricing reference."""
import json
import sys
import unittest
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from reference.b import pricing as pr  # noqa: E402
from reference.b.pricing import Sample as S  # noqa: E402

GOLD = {c["id"]: c for c in json.loads((ROOT / "reference/fixtures/golden_cases.json").read_text())["cases"]}
W = 10**18


def dense(t0, t1, step, price):
    return [S(t, price) for t in range(t0, t1, step)]


class Twap(unittest.TestCase):
    def test_irregular_spacing_is_time_weighted(self):
        # 0.40 for 20 s then 0.70 for 10 s over a 30 s window: (0.4*20 + 0.7*10)/30 = 0.5
        samples = [S(100, 4 * 10**17), S(120, 7 * 10**17)]
        r = pr.twap(samples, 130, 30)
        self.assertTrue(r.available)
        self.assertEqual(r.twap_wad, 5 * 10**17)
        # a sample-count average would give 0.55
        self.assertNotEqual(r.twap_wad, (4 * 10**17 + 7 * 10**17) // 2)

    def test_many_samples_one_period_do_not_add_weight(self):
        samples = [S(100, 4 * 10**17)] + [S(119, 9 * 10**17)] * 5 + [S(120, 7 * 10**17)]
        r = pr.twap(samples, 130, 30)
        # 0.4*19 + 0.9*1 + 0.7*10 over 30
        self.assertEqual(r.integral, F(4 * 10**17 * 19 + 9 * 10**17 + 7 * 10**17 * 10))

    def test_same_timestamp_adds_no_weight(self):
        a = pr.twap([S(100, 4 * 10**17), S(100, 6 * 10**17)], 130, 30)
        b = pr.twap([S(100, 6 * 10**17)], 130, 30)
        self.assertEqual(a, b)

    def test_gap_not_carried_past_30s(self):
        samples = [S(0, 5 * 10**17), S(60, 5 * 10**17)]
        r = pr.twap(samples, 90, 90)
        self.assertFalse(r.available)
        self.assertEqual(r.covered_secs, 60)  # [0,30) and [60,90)
        self.assertIsNone(r.twap_wad)

    def test_exact_30s_boundary(self):
        self.assertTrue(pr.twap([S(0, 5 * 10**17)], 30, 30).available)
        self.assertFalse(pr.twap([S(0, 5 * 10**17)], 31, 31).available)

    def test_invalid_sample_breaks_coverage(self):
        samples = [S(0, 5 * 10**17), S(10, 0, False), S(20, 5 * 10**17)]
        r = pr.twap(samples, 30, 30)
        self.assertEqual(r.covered_secs, 20)
        self.assertFalse(r.available)

    def test_empty_window(self):
        r = pr.twap([], 300, 300)
        self.assertEqual((r.available, r.covered_secs), (False, 0))

    def test_carry_in_from_before_window(self):
        r = pr.twap([S(95, 3 * 10**17), S(110, 3 * 10**17)], 130, 30)
        self.assertTrue(r.available)
        self.assertEqual(r.twap_wad, 3 * 10**17)

    def test_future_samples_ignored(self):
        r = pr.twap(dense(0, 300, 10, 4 * 10**17) + [S(301, 9 * 10**17)], 300, 300)
        self.assertEqual(r.twap_wad, 4 * 10**17)

    def test_floor_rounding(self):
        r = pr.twap([S(0, 1), S(1, 2), S(2, 2)], 3, 3)  # (1 + 2 + 2)/3
        self.assertEqual(r.twap_wad, 1)

    def test_freshness_value_at(self):
        g = GOLD["G13_stale_boundaries"]
        t0 = g["input"]["observed_at"]
        for t in g["expected"]["fresh_at"]:
            self.assertIsNotNone(pr.value_at([S(t0, 5 * 10**17)], t))
        for t in g["expected"]["stale_at"]:
            self.assertIsNone(pr.value_at([S(t0, 5 * 10**17)], t))


class DepthAndBasis(unittest.TestCase):
    def test_impact_mid(self):
        self.assertEqual(pr.impact_mid(59 * 10**16, 61 * 10**16, 500, 500, 500, 5 * 10**16), 6 * 10**17)
        self.assertIsNone(pr.impact_mid(59 * 10**16, 61 * 10**16, 499, 500, 500, 5 * 10**16))
        self.assertIsNone(pr.impact_mid(59 * 10**16, 61 * 10**16, 500, 500, 500, 10**16))
        self.assertIsNone(pr.impact_mid(61 * 10**16, 59 * 10**16, 500, 500, 500, 10**17))

    def test_basis_uses_contemporaneous_index(self):
        perp = [S(100, 62 * 10**16), S(200, 63 * 10**16)]
        index = [S(95, 60 * 10**16), S(150, 61 * 10**16)]
        b = pr.basis_samples(perp, index)
        self.assertEqual(b[0], S(100, 2 * 10**16))
        self.assertFalse(b[1].valid)  # index at 150 is stale by 200

    def test_negative_basis(self):
        b = pr.basis_samples([S(10, 58 * 10**16)], [S(10, 60 * 10**16)])
        self.assertEqual(b[0].price_wad, -2 * 10**16)


class Mark(unittest.TestCase):
    def test_golden_band_clamp(self):
        g = GOLD["G20_mark_band"]["input"]
        e = GOLD["G20_mark_band"]["expected"]
        self.assertEqual(pr.band_wad(g["now"], g["T"], g["listed_at"]), int(e["band_wad"]))
        m = pr.mark(int(g["index_wad"]), int(g["basis_wad"]), int(g["perp_twap_wad"]),
                    int(g["perp_live_wad"]), g["now"], g["T"], g["listed_at"])
        self.assertEqual(m, int(e["mark_wad"]))

    def test_all_median_orderings(self):
        import itertools
        vals = [61 * 10**16, 62 * 10**16, 63 * 10**16]
        for perm in itertools.permutations(vals):
            idx = 60 * 10**16
            m = pr.mark(idx, perm[0] - idx, perm[1], perm[2], 0, 10**6, 0 - 10**6)
            self.assertEqual(m, 62 * 10**16, perm)

    def test_band_zero_at_t(self):
        self.assertEqual(pr.band_wad(1000, 1000, 0), 0)
        self.assertEqual(pr.mark(6 * 10**17, 10**17, 7 * 10**17, 7 * 10**17, 1000, 1000, 0), 6 * 10**17)

    def test_missing_candidate_unavailable(self):
        self.assertIsNone(pr.mark(6 * 10**17, None, 6 * 10**17, 6 * 10**17, 0, 10, -10))
        self.assertIsNone(pr.mark(None, 0, 6 * 10**17, 6 * 10**17, 0, 10, -10))


class Funding(unittest.TestCase):
    def test_golden_quantization(self):
        g = GOLD["G16_funding_rate_quantization"]
        for inp, exp in zip(g["input"], g["expected"]):
            self.assertEqual(pr.funding_rate(int(inp["q_wad"]), int(inp["i_wad"])), int(exp["rate_Q_per_lot_sec"]))

    def test_units_explicit(self):
        # f = +0.01 USDC per claim per day -> per lot per second in Q: 0.01 * 1000 * 1e18 / 86400
        r = pr.funding_rate(61 * 10**16, 60 * 10**16)
        self.assertEqual(r, (10**16 * 1000) // 86400)
        self.assertEqual(r, int(F(1, 100) * 1000 * 10**18 / 86400))

    def test_truncation_toward_zero_both_signs(self):
        up = pr.funding_rate(60 * 10**16 + 7, 60 * 10**16)
        down = pr.funding_rate(60 * 10**16 - 7, 60 * 10**16)
        self.assertEqual(up, -down)
        self.assertEqual(up, 7 * 1000 // 86400)  # 0 for tiny f: truncated, not floored to -1

    def test_epoch_recommendation(self):
        self.assertEqual(pr.recommend_epoch_rate(6 * 10**17, 6 * 10**17, 10, False).reason, "FUNDING_DISABLED")
        self.assertEqual(pr.recommend_epoch_rate(None, 6 * 10**17, 10, True).reason, "STALE_PRICE")
        z = pr.recommend_epoch_rate(62 * 10**16, 60 * 10**16, 0, True)
        self.assertEqual((z.authorized, z.reason), (False, "ZERO_OI"))
        ok = pr.recommend_epoch_rate(62 * 10**16, 60 * 10**16, 10, True)
        self.assertEqual((ok.authorized, ok.rate_q_per_lot_sec), (True, 231481481481481))


class Movement(unittest.TestCase):
    def test_trigger(self):
        idx = [S(0, 50 * 10**16)] + dense(10, 301, 10, 50 * 10**16) + [S(300, 61 * 10**16)]
        self.assertTrue(pr.movement_trigger(idx, 300))
        idx2 = [S(0, 50 * 10**16)] + dense(10, 301, 10, 50 * 10**16) + [S(300, 60 * 10**16)]
        self.assertFalse(pr.movement_trigger(idx2, 300))  # exactly 0.10 does not exceed

    def test_missing_history_no_trigger(self):
        self.assertFalse(pr.movement_trigger([S(300, 9 * 10**17)], 300))


if __name__ == "__main__":
    unittest.main()
