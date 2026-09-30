import dataclasses
import math
import random
import unittest
from fractions import Fraction

from reference.common import units as u


class UnitsTest(unittest.TestCase):
    def test_one_lot_one_tick_is_one_atom(self):
        self.assertEqual(u.fill_value_q(1, 1), u.atoms_to_q(1))
        self.assertEqual(u.fill_value_q(17, 613), 10421 * u.Q)

    def test_mark_scale_has_no_second_wad_division(self):
        self.assertEqual(u.position_value_q(17, u.tick_to_wad(613)), 10421 * u.Q)
        self.assertEqual(u.position_value_q(-17, u.tick_to_wad(613)), -10421 * u.Q)
        self.assertEqual(u.position_value_q(1, u.WAD), u.PAYOFF_Q_PER_LOT)

    def test_source_ledger_identity_in_selected_units(self):
        # PDF A1: b + z*m. This is a dimensional fixture, not the A003 ledger engine.
        cash_q = -480_000_000 * u.Q
        lots = u.claims_to_lots(Fraction(1000))
        self.assertEqual(cash_q + u.position_value_q(lots, 0), -480_000_000 * u.Q)
        self.assertEqual(cash_q + u.position_value_q(lots, u.WAD), 520_000_000 * u.Q)
        self.assertEqual(cash_q + u.position_value_q(lots, 6 * 10**17), 120_000_000 * u.Q)

    def test_exact_claim_conversion_rejects_float_and_sub_lot(self):
        self.assertEqual(u.claims_to_lots(Fraction(17, 1000)), 17)
        self.assertEqual(u.claims_to_lots(-1000), -1_000_000)
        with self.assertRaises(ValueError):
            u.claims_to_lots(Fraction(1, 1001))
        with self.assertRaises(TypeError):
            u.claims_to_lots(0.001)

    def test_directed_signed_rounding_against_fraction(self):
        rng = random.Random(u.REFERENCE_SEED)
        cases = [(a, b) for a in (-7, -6, -1, 0, 1, 6, 7) for b in (-3, 3)]
        cases += [(rng.randint(-(2**255), 2**255 - 1), rng.choice((-1, 1)) * rng.randint(1, 2**180))
                  for _ in range(512)]
        for a, b in cases:
            exact = Fraction(a, b)
            self.assertEqual(u.floor_div(a, b), math.floor(exact))
            self.assertEqual(u.ceil_div(a, b), math.ceil(exact))
        for divide in (u.floor_div, u.ceil_div):
            with self.assertRaises(ZeroDivisionError):
                divide(1, 0)

    def test_strict_cash_and_inclusive_position_bounds(self):
        for sign in (-1, 1):
            u.AccountInput(sign * u.MAX_POSITION_LOTS, sign * (u.CASH_Q_BOUND - 1))
            with self.assertRaises(ValueError):
                u.AccountInput(sign * (u.MAX_POSITION_LOTS + 1), 0)
            with self.assertRaises(ValueError):
                u.AccountInput(0, sign * u.CASH_Q_BOUND)

    def test_settlement_endpoints_are_not_trading_ticks(self):
        for p in (0, u.WAD):
            self.assertEqual(u.checked_price_wad(p), p)
            with self.assertRaises(ValueError):
                u.checked_price_wad(p, live=True)
        for tick in (0, 1000, -1):
            with self.assertRaises(ValueError):
                u.tick_to_wad(tick)

    def test_fractional_q_cannot_round_up_to_atoms(self):
        self.assertEqual(u.q_to_atoms_down(u.Q - 1), 0)
        self.assertEqual(u.q_to_atoms_down(2 * u.Q - 1), 1)
        with self.assertRaises(ValueError):
            u.q_to_atoms_down(-1)
        with self.assertRaises(ValueError):
            u.atoms_to_q(u.UINT256_MAX // u.Q + 1)

    def test_binary_y_and_oracle_enum_are_distinct(self):
        self.assertEqual(u.from_binary_y(0), u.FinalOutcome.NO)
        self.assertEqual(u.from_binary_y(1), u.FinalOutcome.YES)
        self.assertEqual(u.from_oracle_outcome(u.OracleOutcome.YES), u.FinalOutcome.YES)
        self.assertEqual(u.from_oracle_outcome(u.OracleOutcome.NO), u.FinalOutcome.NO)
        self.assertEqual(u.from_oracle_outcome(u.OracleOutcome.INVALID), u.FinalOutcome.INVALID)
        self.assertNotEqual(u.OracleOutcome.YES.value, u.FinalOutcome.YES.value)
        for y in (2, 1000, u.WAD):
            with self.assertRaises(ValueError):
                u.from_binary_y(y)
        for y in (True, 1.0, u.OracleOutcome.YES):
            with self.assertRaises(TypeError):
                u.from_binary_y(y)
        with self.assertRaises(ValueError):
            u.from_oracle_outcome(u.OracleOutcome.NONE)
        with self.assertRaises(TypeError):
            u.from_oracle_outcome(u.FinalOutcome.YES)

    def test_payoff_records_require_finality_and_matching_price(self):
        u.PayoffInput(0, 0, u.FinalOutcome.NO, 0)
        u.PayoffInput(0, 0, u.FinalOutcome.YES, u.WAD)
        for price in (0, u.WAD // 2, u.WAD):
            u.PayoffInput(0, 0, u.FinalOutcome.INVALID, price)
        for outcome, price in ((u.FinalOutcome.UNSET, 0), (u.FinalOutcome.NO, 1),
                               (u.FinalOutcome.YES, 0), (u.FinalOutcome.INVALID, u.WAD + 1)):
            with self.assertRaises(ValueError):
                u.PayoffInput(0, 0, outcome, price)
        with self.assertRaises(TypeError):
            u.PayoffInput(0, 0, u.OracleOutcome.YES, u.WAD)

    def test_order_epochs_and_version_wrap(self):
        order = u.OrderInput(u.Side.BUY, 613, 17, market_order_epoch=2**32 + 1)
        self.assertEqual(order.market_order_epoch, 2**32 + 1)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            order.remaining_lots = 18
        self.assertEqual(u.next_version(0), 1)
        with self.assertRaises(ValueError):
            u.next_version(u.UINT64_MAX)
        for lots in (0, u.UINT64_MAX + 1):
            with self.assertRaises(ValueError):
                u.OrderInput(u.Side.BUY, 1, lots)
        with self.assertRaises(TypeError):
            u.OrderInput(0, 1, 1)

    def test_funding_records_keep_explicit_units_and_cutoffs(self):
        good = u.FundingInput(1, 0, 3600, 30, 60, 0, -1, 100, -40, 1000)
        for change in ({"epoch_id": 0}, {"epoch_end": 0}, {"last_accrued_at": 61},
                       {"effective_stop_at": 3601}, {"oi_all_lots": 39},
                       {"rate_q_per_lot_sec": u.INT256_MAX + 1}, {"remaining_budget_q": -1}):
            with self.assertRaises(ValueError):
                dataclasses.replace(good, **change)


if __name__ == "__main__":
    unittest.main()
