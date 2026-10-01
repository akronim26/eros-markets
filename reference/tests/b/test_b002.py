"""B002: golden cases are complete and each expected value re-derives by hand arithmetic.

Re-derivation here uses only Fraction/Decimal and the spec formulas written inline. It does not
import any reference/b or reference/a module (those are what the cases will later test).
"""
import json
import unittest
from decimal import Decimal as D, getcontext
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIX = json.loads((ROOT / "reference/fixtures/golden_cases.json").read_text())
CASES = {c["id"]: c for c in FIX["cases"]}
Q = 10**18
U = 1000 * Q  # PAYOFF_Q_PER_LOT


def endpoints(c, n, q_wad):
    return c, c + U * n, c + 1000 * n * q_wad


class Structure(unittest.TestCase):
    def test_required_cases_present(self):
        required = ["G01_fill_17_at_613", "G02_long_endpoints", "G03_short_endpoints", "G04_flat",
                    "G05_zero_equity_takeover", "G07_direct5x_long_29d", "G15_future_window_invalid"]
        for r in required:
            self.assertIn(r, CASES)

    def test_every_case_labelled(self):
        for c in FIX["cases"]:
            with self.subTest(c=c["id"]):
                self.assertIn(c["kind"], ("exact", "interval"))
                self.assertTrue(c["derivation"].strip())
                self.assertIn("expected", c)

    def test_interval_cases_have_brackets(self):
        for c in FIX["cases"]:
            if c["kind"] != "interval":
                continue
            for k, v in c["expected"].items():
                if isinstance(v, dict) and "lo" in v:
                    self.assertLess(D(v["lo"]), D(v["hi"]), f"{c['id']}.{k}")

    def test_constants(self):
        self.assertEqual(int(FIX["constants"]["Q"]), Q)
        self.assertEqual(int(FIX["constants"]["PAYOFF_Q_PER_LOT"]), U)


class ExactLedger(unittest.TestCase):
    def test_g01(self):
        e = CASES["G01_fill_17_at_613"]["expected"]
        self.assertEqual(17 * 613, int(e["notional_atoms"]))
        self.assertEqual(17 * 613 * Q, int(e["notional_Q"]))
        self.assertEqual(-int(e["taker_dcash_Q"]), int(e["maker_dcash_Q"]))
        self.assertEqual(e["taker_dx_lots"] + e["maker_dx_lots"], 0)

    def test_endpoint_cases(self):
        for cid in ["G02_long_endpoints", "G03_short_endpoints", "G04_flat", "G05_zero_equity_takeover"]:
            c = CASES[cid]
            i, e = c["input"], c["expected"]
            e0, e1, em = endpoints(int(i["cash_Q"]), i["position_lots"], int(i["mark_wad"]))
            with self.subTest(cid=cid):
                self.assertEqual(e0, int(e["E0_Q"]))
                self.assertEqual(e1, int(e["E1_Q"]))
                self.assertEqual(em, int(e["mark_equity_Q"]))
                if "d0_Q" in e:
                    self.assertEqual(max(0, -e0), int(e["d0_Q"]))
                    self.assertEqual(max(0, -e1), int(e["d1_Q"]))

    def test_g05_takeover_slack(self):
        e = CASES["G05_zero_equity_takeover"]["expected"]
        for key, ey in [("reserve_slack_change_NO_Q", int(e["E0_Q"])), ("reserve_slack_change_YES_Q", int(e["E1_Q"]))]:
            self.assertEqual(ey + max(-ey, 0), int(e[key]))
        self.assertEqual(e["liquidation_mode"], "TAKEOVER")

    def test_g06_settlement(self):
        c = CASES["G06_settlement_all_outcomes"]
        a, b = c["input"]["alice"], c["input"]["bob"]
        assets = int(c["input"]["market_assets_atoms"])
        for label, row in c["expected"].items():
            p = int(row["p_wad"])
            pay = []
            for acct in (a, b):
                eq = int(acct["cash_Q"]) + acct["position_lots"] * 1000 * p
                pay.append(max(0, eq) // Q)
            with self.subTest(outcome=label):
                self.assertEqual(pay, [int(row["alice_atoms"]), int(row["bob_atoms"])])
                self.assertEqual(sum(pay), int(row["total_atoms"]))
                self.assertEqual(assets - sum(pay), int(row["reserve_residual_atoms"]))

    def test_g09_full_backing(self):
        c = CASES["G09_missing_calibration_is_1x"]
        worst = abs(c["input"]["position_lots"]) * 1000 * int(c["input"]["q_wad"])
        self.assertEqual(worst, int(c["expected"]["IM_Q"]))
        self.assertTrue(c["expected"]["full_backing_required"])

    def test_g10_oversized_ask(self):
        c = CASES["G10_oversized_ask_both_outcomes"]["input"]
        e = CASES["G10_oversized_ask_both_outcomes"]["expected"]
        yes = int(c["cash_Q"]) + U * c["position_lots"] - U * c["ask_lots"] + c["ask_lots"] * c["ask_tick"] * Q
        self.assertEqual(yes, int(e["yes_value_after_full_fill_Q"]))
        self.assertEqual(max(0, -yes), int(e["d1_Q"]))
        self.assertFalse(e["admit_1x"])

    def test_g11_cancel(self):
        c = CASES["G11_cancel_needs_tick"]
        rests = c["input"]["rests"]
        left = [r for k, r in enumerate(rests) if k != c["input"]["cancel_index"]]
        self.assertEqual(sum(r[0] for r in left), c["expected"]["bid_lots"])
        self.assertEqual(sum(r[0] * r[1] for r in left), int(c["expected"]["bid_value_atoms"]))

    def test_g12_emin(self):
        i = CASES["G12_direct5x_emin"]["input"]
        e = CASES["G12_direct5x_emin"]["expected"]
        mq = 1000 * int(i["q_wad"])
        emin = (int(i["cash_Q"]) + i["position_lots"] * mq
                - i["bid_lots"] * max(i["max_bid_tick"] * Q - mq, 0)
                - i["ask_lots"] * max(mq - i["min_ask_tick"] * Q, 0) - int(i["fee_cap_Q"]))
        self.assertEqual(emin, int(e["emin_Q"]))
        self.assertEqual(int(i["cash_Q"]) - i["bid_lots"] * i["max_bid_tick"] * Q, int(e["rectangle_Q"]))

    def test_g14_stages(self):
        T = CASES["G14_stage_boundaries"]["input"]["T"]

        def stage(t):
            if t >= T:
                return "HALTED"
            if t >= T - 3600:
                return "REDUCE_ONLY"
            if t >= T - 43200:
                return "BACKING_FLOOR"
            if t >= T - 45000:
                return "BACKING_GRACE"
            return "TRADING"
        for t, s in CASES["G14_stage_boundaries"]["expected"].items():
            self.assertEqual(stage(int(t)), s, t)

    def test_g15_window(self):
        c = CASES["G15_future_window_invalid"]
        T = c["input"]["T"]
        self.assertEqual(c["expected"]["window"], [T - 86400, T])
        self.assertLess(c["input"]["early_halt_at"], T)
        self.assertEqual(int(c["expected"]["incomplete_new_listing"]["fallback_wad"]), Q // 2)
        self.assertIn(str(T + c["input"]["grace_secs"]), c["expected"]["incomplete_new_listing"])

    def test_g16_rate(self):
        c = CASES["G16_funding_rate_quantization"]
        for inp, exp in zip(c["input"], c["expected"]):
            q, i = int(inp["q_wad"]), int(inp["i_wad"])
            bound = 5 * min(i, Q - i) // 100
            f = max(-bound, min(bound, q - i))
            self.assertEqual(f, int(exp["f_wad"]))
            r = abs(f) * 1000 // 86400
            self.assertEqual(r if f >= 0 else -r, int(exp["rate_Q_per_lot_sec"]))

    def test_g17_pair_tick(self):
        c = CASES["G17_pair_tick"]
        got = [max(1, min(999, int(q) // 10**15)) for q in c["input"]]
        self.assertEqual(got, c["expected"])

    def test_g18_bankruptcy(self):
        i = CASES["G18_bankruptcy_tick_long"]["input"]
        n = i["close_lots"]
        need = int(i["threshold_Q"]) - int(i["cash_Q"]) + int(i["fee_Q"])  # position after = 0
        t = -(-need // (n * Q))
        self.assertEqual(t, CASES["G18_bankruptcy_tick_long"]["expected"]["worst_tick"])

    def test_g20_mark(self):
        c = CASES["G20_mark_band"]
        i = c["input"]
        band = F(5, 100) * max(i["T"] - i["now"], 0) / (i["T"] - i["listed_at"])
        self.assertEqual(band * Q, int(c["expected"]["band_wad"]))
        idx = int(i["index_wad"])
        cands = sorted([idx + int(i["basis_wad"]), int(i["perp_twap_wad"]), int(i["perp_live_wad"])])
        self.assertEqual(cands[1], int(c["expected"]["median_wad"]))
        b = int(band * Q)
        self.assertEqual(max(idx - b, min(idx + b, cands[1])), int(c["expected"]["mark_wad"]))


class RiskIntervals(unittest.TestCase):
    def setUp(self):
        getcontext().prec = 60

    def margins(self, long):
        q, x, h, T = D("0.6"), D(1000), D(360), D(29 * 86400)
        a = D("0.0001") * h / D(86400)
        ep = (D("0.01") - a) / (1 - a)
        k = ((1 - ep) / ep).sqrt()
        sig = (q * (1 - q) * h / T).sqrt()
        w = q if long else 1 - q
        m = ((1 - q) if long else q) * a / (1 - 2 * a)
        mm = min(x * w, x * (m + k * sig + D("0.005")) + D("0.5") * D("0.000001") * x * x)
        im = min(x * w, max(D("1.5") * mm, x * w / 5))
        return a, k, sig, mm, im

    def inside(self, v, br):
        return D(br["lo"]) <= v <= D(br["hi"])

    def test_g07_long(self):
        e = CASES["G07_direct5x_long_29d"]["expected"]
        self.assertEqual(300 + 1000 * 60 // 1000, int(e["h_secs"]["exact"]))
        a, k, sig, mm, im = self.margins(True)
        self.assertTrue(self.inside(a, e["a_upper"]))
        self.assertTrue(self.inside(k, e["k"]))
        self.assertTrue(self.inside(sig, e["sigma"]))
        self.assertTrue(self.inside(mm, e["MM_usdc"]))
        self.assertTrue(self.inside(D("1.5") * mm, e["gammaMM_usdc"]))
        self.assertEqual(im, D(e["IM_usdc"]["exact"]))
        self.assertTrue(e["admits_with_120_usdc"])
        self.assertEqual(D(e["worst_loss_usdc"]["exact"]) / im, D(e["display_leverage_x"]["exact"]))

    def test_g08_short(self):
        e = CASES["G08_short_100_vs_80"]["expected"]
        _, _, _, mm, im = self.margins(False)
        self.assertTrue(self.inside(mm, e["MM_usdc"]))
        self.assertTrue(self.inside(im, e["IM_usdc"]))
        self.assertEqual(D(80) >= im, e["collateral_80_passes"])
        self.assertEqual(D(100) >= im, e["collateral_100_passes"])


if __name__ == "__main__":
    unittest.main()
