"""Regression checks for historical, append-only live INDEX replay."""
import runpy
import unittest
from pathlib import Path

replay = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/review-live-factory.py"))["replay"]


def observation(at, price, valid=True, block=1):
    return {"packet": {"observation": {"observedAt": str(at), "priceWad": str(price)}},
            "accepted": {"blockNumber": str(block), "depthValid": valid}}


class LiveReplayTest(unittest.TestCase):
    def test_contiguous_authentic_intervals_cover_exact_window(self):
        values = [observation(at, 7) for at in range(0, 300, 30)]
        self.assertEqual(replay(values, {"number": "1", "timestamp": "300"}),
                         {"available": True, "coveredSecs": "300", "integral": "2100", "twapWad": "7"})

    def test_later_same_second_invalidation_cannot_rewrite_historical_block(self):
        values = [observation(at, 7) for at in range(0, 300, 30)]
        values.append(observation(270, 0, valid=False, block=2))
        self.assertEqual(replay(values, {"number": "1", "timestamp": "300"})["coveredSecs"], "300")
        self.assertEqual(replay(values, {"number": "2", "timestamp": "300"})["coveredSecs"], "270")

    def test_missing_source_intervals_stay_unavailable(self):
        result = replay([observation(0, 7), observation(60, 7)], {"number": "1", "timestamp": "300"})
        self.assertEqual(result, {"available": False, "coveredSecs": "60", "integral": "420", "twapWad": "0"})


if __name__ == "__main__":
    unittest.main()
