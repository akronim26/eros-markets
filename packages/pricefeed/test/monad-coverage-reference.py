"""Hand-derived independent coverage checks; no RPC or pricefeed calculation imports."""
import json
import runpy
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
replay = runpy.run_path(str(PACKAGE / 'scripts/review-monad-coverage.py'))['replay']
PRICE = 630000000000000000


def history(times, validity=None):
    validity = validity or [True] * len(times)
    items = [{'packet': {'observation': {'observedAt': str(t)}}} for t in times]
    receipts = [{'accepted': {'blockNumber': str(i+1), 'acceptedAt': str(t+2),
                 'priceWad': str(PRICE if v else 0), 'depthValid': v}}
                for i, (t, v) in enumerate(zip(times, validity, strict=True))]
    return items, receipts


class CoverageReference(unittest.TestCase):
    def test_full_and_expired_carry(self):
        items, receipts = history(list(range(1000, 1301, 20)))
        self.assertEqual(replay(items, receipts, {'number': '16', 'timestamp': '1302'}),
                         {'available': True, 'coveredSecs': '300', 'integral': '189000000000000000000', 'twapWad': str(PRICE)})
        self.assertEqual(replay(items, receipts, {'number': '16', 'timestamp': '1368'}),
                         {'available': False, 'coveredSecs': '262', 'integral': '165060000000000000000', 'twapWad': '0'})

    def test_invalid_replacement_is_filtered_at_historical_block(self):
        items, receipts = history([*range(1000, 1301, 20), 1300], [True] * 16 + [False])
        self.assertEqual(replay(items, receipts, {'number': '16', 'timestamp': '1302'})['coveredSecs'], '300')
        self.assertEqual(replay(items, receipts, {'number': '17', 'timestamp': '1302'})['coveredSecs'], '298')

    def test_missing_and_invalid_intervals_are_uncovered(self):
        items, receipts = history([1000, 1020, 1060], [True, False, True])
        self.assertEqual(replay(items, receipts, {'number': '3', 'timestamp': '1092'}),
                         {'available': False, 'coveredSecs': '50', 'integral': '31500000000000000000', 'twapWad': '0'})

    def test_original_short_run_remains_unavailable(self):
        report = json.loads((PACKAGE / 'artifacts/monad-testnet/optimized-small-run.json').read_text())
        result = replay(report['packets'], report['receipts'], report['twap']['evaluationBlock'])
        self.assertEqual(result, report['twap']['actual'])
        self.assertEqual(result['coveredSecs'], '134')
        self.assertFalse(result['available'])

    def test_failed_initial_campaign_keeps_its_real_missing_seconds(self):
        report = json.loads((PACKAGE / 'artifacts/monad-testnet/coverage-initial-run.json').read_text())
        phase = report['checks'][0]
        result = replay(report['packets'], report['receipts'], phase['block'])
        self.assertEqual(result, phase['actual'])
        self.assertEqual(result['coveredSecs'], '268')
        self.assertFalse(result['available'])
        self.assertTrue(report['evidenceVerified'])
        self.assertFalse(report['acceptance']['verified'])


if __name__ == '__main__':
    unittest.main()
