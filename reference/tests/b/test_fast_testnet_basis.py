"""Risk check for the Monad testnet BASIS window change (180 s -> 60 s).

Uses the exact pricing reference (`reference/b/pricing.py`); expected values are derived by hand
in the comments. Prices are wad; samples every 10 s; carry 30 s.

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


if __name__ == "__main__":
    unittest.main()
