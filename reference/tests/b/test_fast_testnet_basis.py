"""Risk check for the Monad testnet BASIS window change (180 s -> 60 s).

Uses the exact pricing reference (`reference/b/pricing.py`); expected values are derived by hand
in the comments. Prices are wad; samples every 10 s; carry 30 s unless a class says otherwise
(BookCarry and IndexCarry use the Monad testnet carries of 300 s and 120 s).

Findings, all bounded by the I +/- b(t) clamp (b <= 0.05):
* Manipulation: the median already follows the two 60-second book candidates, so a 60-second
  BASIS adds no cheaper path to move MARK while INDEX is steady.
* Genuine INDEX jump with a lagging book: the shorter window absorbs the transient basis faster,
  so MARK lags the new INDEX more (and longer at the clamp) before the book reprices.
* Book noise: MARK stays inside the noise envelope for both windows; the 60-second BASIS adds
  a little more short-term movement.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from reference.b import pricing as p  # noqa: E402

WAD = p.WAD
T = 10**7          # scheduled T; listed at 0, so b(t) ~= 0.05 near t = 1000
LISTED = 0
FAST, SLOW = 60, 180


def series(start, end, value_at_t):
    return [p.Sample(t, value_at_t(t)) for t in range(start, end + 1, 10)]


def mark_at(now, index, perp, basis_window):
    idx = p.twap(index, now, 60)
    bas = p.twap(p.basis_samples(perp, index), now, basis_window)
    prp = p.twap(perp, now, p.PERP_WINDOW)
    live = p.value_at(perp, now)
    if not (idx.available and bas.available and prp.available) or live is None:
        return None
    return p.mark(idx.twap_wad, bas.twap_wad, prp.twap_wad, live, now, T, LISTED)


class Manipulation(unittest.TestCase):
    """INDEX steady at 0.50; the book is pushed to 0.53 for tau seconds before `now`."""

    def run_case(self, tau, window):
        now = 1000
        index = series(700, now, lambda t: 5 * 10**17)
        perp = series(700, now, lambda t: 53 * 10**16 if t >= now - tau else 5 * 10**17)
        return mark_at(now, index, perp, window)

    def test_thirty_second_push_moves_mark_equally(self):
        # perp60 = (30*0.50 + 30*0.53)/60 = 0.515; live 0.53.
        # A60 = 0.50 + 0.03*30/60 = 0.515; A180 = 0.50 + 0.03*30/180 = 0.505.
        # median(0.515, 0.515, 0.53) = median(0.505, 0.515, 0.53) = 0.515.
        self.assertEqual(self.run_case(30, FAST), 515 * 10**15)
        self.assertEqual(self.run_case(30, SLOW), 515 * 10**15)

    def test_sustained_push_moves_mark_equally(self):
        # After 90 s both book candidates read 0.53; the median is 0.53 for either window.
        self.assertEqual(self.run_case(90, FAST), 53 * 10**16)
        self.assertEqual(self.run_case(90, SLOW), 53 * 10**16)

    def test_any_push_duration_has_identical_mark(self):
        for tau in range(0, 200, 10):
            self.assertEqual(self.run_case(tau, FAST), self.run_case(tau, SLOW), tau)


class IndexJumpWithLaggingBook(unittest.TestCase):
    """INDEX 0.50 -> 0.60 at 1000; the book stays at 0.50 until it reprices at 1040."""

    def setUp(self):
        self.index = series(700, 1200, lambda t: 5 * 10**17 if t < 1000 else 6 * 10**17)
        self.perp = series(700, 1200, lambda t: 5 * 10**17 if t < 1040 else 6 * 10**17)

    def test_ten_seconds_after_repricing(self):
        now = 1050
        b = p.band_wad(now, T, LISTED)
        self.assertEqual(b, 5 * 10**16 * (T - now) // T)
        # I = INDEX60 over [990, 1050] = (10*0.5 + 50*0.6)/60 -> 583333333333333333.
        # perp60 = (50*0.5 + 10*0.6)/60 = 31/60 -> 516666666666666666; live 0.6.
        # basis60 integral = -0.1*40 -> twap floor(-4e18/60) = -66666666666666667;
        # A60 = I + basis60 = 516666666666666666; median = 516666666666666666 < I - b,
        # so MARK clamps to I - b.
        i60 = 583333333333333333
        self.assertEqual(mark_at(now, self.index, self.perp, FAST), i60 - b)
        # basis180 = floor(-4e18/180) = -22222222222222223; A180 = 561111111111111110,
        # median(561111111111111110, 516666666666666666, 6e17) is inside the band.
        self.assertEqual(mark_at(now, self.index, self.perp, SLOW), 561111111111111110)

    def test_both_converge_once_the_book_has_repriced_for_a_window(self):
        # From 1100 the PERP and BASIS60 windows hold only post-jump samples.
        self.assertEqual(mark_at(1100, self.index, self.perp, FAST), 6 * 10**17)
        self.assertEqual(mark_at(1100, self.index, self.perp, SLOW), 6 * 10**17)

    def test_mark_never_leaves_the_band_and_fast_lag_is_bounded(self):
        worst_extra_lag = 0
        for now in range(1000, 1200):
            fast = mark_at(now, self.index, self.perp, FAST)
            slow = mark_at(now, self.index, self.perp, SLOW)
            idx = p.twap(self.index, now, 60)
            if fast is None or slow is None or not idx.available:
                continue
            b = p.band_wad(now, T, LISTED)
            for m in (fast, slow):
                self.assertLessEqual(abs(m - idx.twap_wad), b)
            worst_extra_lag = max(worst_extra_lag, slow - fast)
        # The extra lag of the 60-second BASIS never exceeds the 0.05 band itself.
        self.assertGreater(worst_extra_lag, 0)
        self.assertLessEqual(worst_extra_lag, 5 * 10**16)


class BookNoise(unittest.TestCase):
    """INDEX steady at 0.50; book mid alternates 0.49 / 0.51 every sample."""

    def test_mark_stays_inside_the_noise_envelope(self):
        index = series(0, 2000, lambda t: 5 * 10**17)
        perp = series(0, 2000, lambda t: 49 * 10**16 if (t // 10) % 2 else 51 * 10**16)
        steps = {}
        for window in (FAST, SLOW):
            previous, worst_step = None, 0
            for now in range(300, 2000):
                m = mark_at(now, index, perp, window)
                self.assertIsNotNone(m)
                # Every candidate lies in [0.49, 0.51], so their median does too.
                self.assertGreaterEqual(m, 49 * 10**16)
                self.assertLessEqual(m, 51 * 10**16)
                if previous is not None:
                    worst_step = max(worst_step, abs(m - previous))
                previous = m
            steps[window] = worst_step
        self.assertGreaterEqual(steps[FAST], steps[SLOW])
        self.assertLessEqual(steps[FAST], 2 * 10**16)



INDEX_CARRY, BOOK_CARRY = 120, 300   # Monad testnet only; other chains keep 30 s for both


def index80(start, end, value_at_t=lambda t: 5 * 10**17):
    """Authenticated INDEX observations on the lower-cost testnet cadence, one every 80 s."""
    return [p.Sample(t, value_at_t(t)) for t in range(start, end + 1, 80)]


def mark_testnet(now, index, perp, basis_window=FAST):
    """MARK with the testnet carries: INDEX 120 s, sealed book samples 300 s."""
    idx = p.twap(index, now, 60, stale_secs=INDEX_CARRY)
    bas = p.twap(p.basis_samples(perp, index, stale_secs=INDEX_CARRY), now, basis_window,
                 stale_secs=BOOK_CARRY)
    prp = p.twap(perp, now, p.PERP_WINDOW, stale_secs=BOOK_CARRY)
    live = p.value_at(perp, now, stale_secs=BOOK_CARRY)
    if not (idx.available and bas.available and prp.available) or live is None:
        return None
    return p.mark(idx.twap_wad, bas.twap_wad, prp.twap_wad, live, now, T, LISTED)


class BookCarry(unittest.TestCase):
    """Monad testnet book samples (PERP/BASIS) carry 300 s.

    A capture seals only on a later authenticated INDEX observation. With one publish and one
    sample per 80 s cycle, sealed book samples are about two cycles (160 s) apart: 30 s and the
    earlier 90 s lapse, 300 s does not. The longer carry only lets an unchanged, confirmed book
    sample count longer; MARK still needs an INDEX within its carry and stays clamped to
    I +/- b(t).
    """

    def test_two_cycle_seal_gap_lapses_at_30_and_90_and_holds_at_300(self):
        index = index80(700, 1170)                                   # last observation 1100
        perp = [p.Sample(t, 51 * 10**16) for t in range(700, 1171, 160)]  # last sample 1020
        now = 1170
        # Window [1110, 1170]: the 1020 sample covers [1020, 1050] at 30 s, [1020, 1110] at 90 s
        # and [1020, 1320] at 300 s.
        self.assertFalse(p.twap(perp, now, 60).available)
        self.assertEqual(p.twap(perp, now, 60, stale_secs=90).covered_secs, 0)
        self.assertTrue(p.twap(perp, now, 60, stale_secs=BOOK_CARRY).available)
        self.assertIsNotNone(mark_testnet(now, index, perp))

    def test_book_gap_beyond_300_seconds_lapses(self):
        index = index80(700, 1400)
        perp = [p.Sample(700, 51 * 10**16), p.Sample(1011, 51 * 10**16)]
        # [1000, 1011) is uncovered: the 700 sample carries only to 1000.
        tw = p.twap(perp, 1040, 60, stale_secs=BOOK_CARRY)
        self.assertFalse(tw.available)
        self.assertEqual(tw.covered_secs, 49)
        self.assertIsNone(mark_testnet(1040, index, perp))

    def test_longer_book_carry_never_survives_a_stale_index(self):
        index = index80(700, 1020)                                   # last observation 1020
        perp = series(700, 1020, lambda t: 51 * 10**16)
        self.assertIsNotNone(mark_testnet(1140, index, perp))
        self.assertIsNone(mark_testnet(1141, index, perp), "INDEX carry 120 s still gates MARK")

    def test_held_book_sample_is_still_clamped_to_the_index_band(self):
        # INDEX moves from 0.50 to 0.60 at 1020 while the last confirmed book sample (0.50) is held.
        index = index80(700, 1340, lambda t: 5 * 10**17 if t < 1020 else 6 * 10**17)
        perp = [p.Sample(t, 5 * 10**17) for t in range(700, 1021, 20)]
        seen = 0
        for now in range(1021, 1320):
            m = mark_testnet(now, index, perp)
            if m is None:
                continue
            seen += 1
            i = p.twap(index, now, 60, stale_secs=INDEX_CARRY).twap_wad
            self.assertLessEqual(abs(m - i), p.band_wad(now, T, LISTED))
        self.assertGreater(seen, 0)


class IndexCarry(unittest.TestCase):
    """Monad testnet INDEX observations carry 120 s (other chains 30 s).

    The publisher sends about every 80 s. A 120 s carry keeps the 60-second INDEX window covered
    between observations and still turns INDEX (and so MARK) off at most 120 s after the last
    observation. The INVALID-window integral uses the same carry, so it stays contiguous.
    """

    def test_eighty_second_cadence_is_continuous_at_120_and_not_at_30(self):
        index = index80(700, 1340)                                   # last observation 1340
        for now in range(760, 1461):
            self.assertTrue(p.twap(index, now, 60, stale_secs=INDEX_CARRY).available, now)
        # Window [760, 820] at 30 s: the 700 sample ends at 730; 780 covers [780, 810] = 30 s.
        self.assertEqual(p.twap(index, 820, 60).covered_secs, 30)

    def test_dead_source_turns_index_off_within_120_seconds(self):
        index = index80(700, 1340)
        self.assertIsNotNone(p.value_at(index, 1460, stale_secs=INDEX_CARRY))
        self.assertIsNone(p.value_at(index, 1461, stale_secs=INDEX_CARRY))
        tw = p.twap(index, 1461, 60, stale_secs=INDEX_CARRY)
        self.assertFalse(tw.available)
        self.assertEqual(tw.covered_secs, 59)                         # [1402, 1460]

    def test_gap_of_121_seconds_breaks_the_window(self):
        index = [p.Sample(1000, 6 * 10**17), p.Sample(1121, 6 * 10**17), p.Sample(1180, 6 * 10**17)]
        tw = p.twap(index, 1180, 60, stale_secs=INDEX_CARRY)
        self.assertFalse(tw.available)
        self.assertEqual(tw.covered_secs, 59)                         # [1120, 1121) uncovered
        exact = [p.Sample(1000, 6 * 10**17), p.Sample(1120, 6 * 10**17), p.Sample(1180, 6 * 10**17)]
        self.assertTrue(p.twap(exact, 1180, 60, stale_secs=INDEX_CARRY).available)

    def test_invalid_window_is_contiguous_and_exact_at_eighty_seconds(self):
        end = 200_000
        start = end - p.INVALID_WINDOW
        # 0.40 for observations before start + 43,200, then 0.70. The change lands on an
        # observation (start - 3,600 + 80 * 585 = start + 43,200), so the integral is exact:
        # (0.40 * 43,200 + 0.70 * 43,200) / 86,400 = 0.55.
        index = [p.Sample(t, 4 * 10**17 if t < start + 43_200 else 7 * 10**17)
                 for t in range(start - 3_600, end + 601, 80)]
        tw = p.twap(index, end, p.INVALID_WINDOW, stale_secs=INDEX_CARRY)
        self.assertTrue(tw.available)
        self.assertEqual(tw.twap_wad, 55 * 10**16)
        self.assertFalse(p.twap(index, end, p.INVALID_WINDOW).available, "30 s carry has gaps")


if __name__ == "__main__":
    unittest.main()
