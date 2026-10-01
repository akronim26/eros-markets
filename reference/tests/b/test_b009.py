"""B009: clock and settlement-readiness reference."""
import dataclasses
import inspect
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from reference.b import lifecycle as lc  # noqa: E402

GOLD = {c["id"]: c for c in json.loads((ROOT / "reference/fixtures/golden_cases.json").read_text())["cases"]}


class Stages(unittest.TestCase):
    def test_golden_boundaries(self):
        g = GOLD["G14_stage_boundaries"]
        T = g["input"]["T"]
        for t, s in g["expected"].items():
            self.assertEqual(lc.derive_stage(int(t), T).stage, s, t)

    def test_flags(self):
        T = 10**6
        v = lc.derive_stage(T - 45000, T)
        self.assertTrue(v.full_backing_by_time)
        self.assertFalse(v.funding_frozen)
        v = lc.derive_stage(T - 43200, T)
        self.assertTrue(v.funding_frozen and v.legacy_takeover_window)

    def test_monitor_and_early_halt(self):
        T = 10**6
        self.assertEqual(lc.derive_stage(0, T, monitor_restricted=True).stage, "REDUCE_ONLY")
        self.assertEqual(lc.derive_stage(500, T, economic_halt_at=400).stage, "HALTED")
        self.assertEqual(lc.derive_stage(300, T, economic_halt_at=400).stage, "TRADING")
        self.assertEqual(lc.derive_stage(T + 5, T, claims_ready=True).stage, "CLAIMS_READY")
        # claims-ready never reopens trading and never appears before halt
        self.assertEqual(lc.derive_stage(5, T, claims_ready=True).stage, "TRADING")

    def test_no_clock_rewrites_balances(self):
        for fn in (lc.derive_stage, lc.accrual_cutoff, lc.funding_cutoff, lc.grace_expired, lc.invalid_readiness):
            params = set(inspect.signature(fn).parameters)
            self.assertFalse({"cash_q", "position_lots", "balance"} & params)
        fields = {f.name for f in dataclasses.fields(lc.StageView)}
        self.assertFalse({"cash_q", "position_lots"} & fields)


class Cutoffs(unittest.TestCase):
    def test_halt_before_roll_equals_roll_before_halt(self):
        epoch_end = 7200
        for halt in (5000, 7200, 9000, 30000):
            # halt before any rollover page: cutoff = min(halt, epoch end)
            a = lc.accrual_cutoff(halt, epoch_end)
            # rollover first froze its cutoff at the epoch end, then the halt arrived
            b = lc.accrual_cutoff(halt, epoch_end, frozen_rollover_cutoff=epoch_end)
            self.assertEqual(a, b)
            self.assertEqual(a, min(halt, epoch_end))

    def test_late_keeper_scheduled_halt(self):
        T = 10**6
        self.assertEqual(lc.economic_halt_at(T, None), T)
        self.assertEqual(lc.economic_halt_at(T, T + 500), T)  # late keeper transaction
        self.assertEqual(lc.economic_halt_at(T, T - 500), T - 500)

    def test_funding_cutoff_precedence(self):
        T = 10**6
        base = dict(now=T - 50000, active_epoch_end=T - 49000, scheduled_t=T, funding_stop_at=None,
                    funding_fresh_through=T - 49500)
        self.assertEqual(lc.funding_cutoff(**base), T - 50000)
        self.assertEqual(lc.funding_cutoff(**{**base, "now": T - 49200}), T - 49500)  # freshness
        self.assertEqual(lc.funding_cutoff(**{**base, "now": T - 1, "funding_fresh_through": T}), T - 49000)
        self.assertEqual(lc.funding_cutoff(**{**base, "now": T, "active_epoch_end": T,
                                              "funding_fresh_through": T}), T - 43200)  # T-12h freeze
        self.assertEqual(lc.funding_cutoff(**{**base, "funding_stop_at": T - 60000}), T - 60000)
        self.assertEqual(lc.funding_cutoff(**{**base, "halt_at": T - 51000}), T - 51000)


class Grace(unittest.TestCase):
    def test_below_mm_no_grace(self):
        self.assertTrue(lc.grace_expired(lc.GraceState(None), 3600, 0, 10**6, below_mm=True))

    def test_repeated_touch_cannot_reset(self):
        g = lc.grace_on_touch(lc.GraceState(None), True, 1000)
        for epoch_start in (4600, 8200, 11800):
            g = lc.grace_on_touch(g, True, epoch_start)
        self.assertEqual(g.anchor, 1000)
        self.assertTrue(lc.grace_expired(g, 3600, 4600, 10**6, False))
        self.assertFalse(lc.grace_expired(g, 3600, 4599, 10**6, False))

    def test_recovery_clears(self):
        g = lc.grace_on_touch(lc.GraceState(1000), False, 5000)
        self.assertIsNone(g.anchor)

    def test_final_day_caps_grace(self):
        T = 10**6
        g = lc.GraceState(T - 44000)
        self.assertTrue(lc.grace_expired(g, 3600, T - 43200, T, False))


class Bootstrap(unittest.TestCase):
    def test_transition_only_at_epoch_opening(self):
        d = lc.pricing_transition("BOOTSTRAP", False, True, True, True, True, False)
        self.assertEqual((d.mode, d.admission), ("BOOTSTRAP", "BACKED_ONLY"))
        d = lc.pricing_transition("BOOTSTRAP", True, True, True, True, True, False)
        self.assertEqual((d.mode, d.admission), ("NORMAL_PRICING", "LEVERAGED"))

    def test_missing_candidate_or_index(self):
        d = lc.pricing_transition("NORMAL_PRICING", False, True, True, False, True, False)
        self.assertEqual(d.admission, "BACKED_ONLY")
        d = lc.pricing_transition("NORMAL_PRICING", False, False, True, True, True, False)
        self.assertEqual(d.admission, "NONE")

    def test_bootstrap_cannot_override_halt(self):
        d = lc.pricing_transition("BOOTSTRAP", True, True, True, True, True, True)
        self.assertEqual(d.admission, "NONE")


class Invalid(unittest.TestCase):
    def test_golden_future_window(self):
        g = GOLD["G15_future_window_invalid"]
        T = g["input"]["T"]
        self.assertEqual(list(lc.invalid_window(T)), g["expected"]["window"])
        for t, s in g["expected"]["status_at"].items():
            self.assertEqual(lc.invalid_readiness(int(t), T, True, True), s)
        c = g["expected"]["complete_constant_042"]
        self.assertEqual(lc.invalid_readiness(c["at"], T, True, True), c["status"])
        for t, s in g["expected"]["incomplete_new_listing"].items():
            if t.isdigit():
                self.assertEqual(lc.invalid_readiness(int(t), T, False, True), s, t)
        for t, s in g["expected"]["incomplete_legacy_listing"].items():
            self.assertEqual(lc.invalid_readiness(int(t), T, False, False), s)

    def test_listing_horizon(self):
        day = 86400
        self.assertTrue(lc.listing_valid(0, day))
        self.assertFalse(lc.listing_valid(0, day - 1))
        self.assertTrue(lc.listing_valid(0, 30 * day - 3600))
        self.assertFalse(lc.listing_valid(0, 30 * day - 3599))


class Finality(unittest.TestCase):
    def test_same_and_conflicting(self):
        s, new = lc.accept_finality("UNSET", "YES")
        self.assertEqual((s, new), ("YES", True))
        self.assertEqual(lc.accept_finality(s, "YES"), ("YES", False))
        with self.assertRaises(lc.ConflictingFinalOutcome):
            lc.accept_finality(s, "NO")
        with self.assertRaises(ValueError):
            lc.accept_finality("UNSET", "UNSET")

    def test_oracle_mapping(self):
        self.assertEqual(lc.oracle_call_for("YES"), ("settle", 1))
        self.assertEqual(lc.oracle_call_for("NO"), ("settle", 0))
        self.assertEqual(lc.oracle_call_for("VOIDED"), ("settleInvalid", None))

    def test_claims_status(self):
        self.assertEqual(lc.claims_ready("INVALID", False, True, True, True), "ORACLE_FINAL_PRICE_PENDING")
        self.assertEqual(lc.claims_ready("YES", True, True, False, True), "ORACLE_FINAL_PREPARING")
        self.assertEqual(lc.claims_ready("YES", True, True, True, False), "RECOVERY_REQUIRED")
        self.assertEqual(lc.claims_ready("YES", True, True, True, True), "CLAIMABLE")
        self.assertEqual(lc.claims_ready("UNSET", True, True, True, True), "AWAITING_OUTCOME")


if __name__ == "__main__":
    unittest.main()
