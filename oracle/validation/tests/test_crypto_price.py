"""ADJ-50: the crypto-price pull, rows and sample.

Fixture tests build a raw store by hand (pages the way the Kalshi API returns them) and check the rows against values
derived here; the sample's evidence URL is checked against Binance's kline parameters computed by hand. Dataset tests
check the committed report against the local rows (skipped where they are absent, ADJ-39).

  cd oracle/validation && python3 -m unittest tests/test_crypto_price.py
"""

from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from dataset import crypto_price as CP
from gate import sample as S
from split.split import split_of


def market(ticker, result="yes", strike_type="greater", close="2026-09-30T23:00:00Z", strike=95299.99):
    return {"ticker": ticker, "event_ticker": ticker.rsplit("-", 1)[0], "title": "Bitcoin price on Sep 30, 2026?", "yes_sub_title": f"${strike} or above",
            "result": result, "strike_type": strike_type, "floor_strike": strike, "close_time": close,
            "rules_primary": f"If ... above {strike} at 7 PM EDT ... resolves to Yes.", "rules_secondary": "Not all price data is the same."}


def store(root: Path, pages: dict[str, list[dict]]) -> None:
    files = []
    for name, markets in pages.items():
        body = json.dumps({"markets": markets, "cursor": ""}).encode()
        (root / "kalshi").mkdir(parents=True, exist_ok=True)
        (root / "kalshi" / f"{name}.json.gz").write_bytes(gzip.compress(body))
        files.append({"file": f"kalshi/{name}.json.gz", "url": f"https://x/{name}", "fetchedAt": "t", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    (root / "MANIFEST.json").write_text(json.dumps({"files": files, "failures": []}))


class Build(unittest.TestCase):
    def test_rows_filters_and_report(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            store(root, {
                "KXBTCD-p200-000": [market("KXBTCD-26SEP3019-T95299.99"), market("KXBTCD-26SEP3019-T90000", "no", strike=90000),
                                    market("KXBTCD-26SEP3019-B95250", strike_type="between"), market("KXBTCD-26SEP3019-T1", "")],
                "KXBTCD-p200-001": [market("KXBTCD-26SEP3019-T95299.99"),  # seen again on the next page: once
                                    market("KXBTCD-26OCT0116-T1", close="2026-10-01T20:00:00Z")],  # after the window
                "KXETHD-p200-000": [market("KXETHD-26SEP3019-T2430", "no", strike=2430), market("KXOTHER-26SEP3019-T5")],
            })
            rows, rep = CP.build(root)
        self.assertEqual([r["market_id"] for r in rows], ["ks:KXBTCD-26SEP3019-T90000", "ks:KXBTCD-26SEP3019-T95299.99", "ks:KXETHD-26SEP3019-T2430"])
        self.assertEqual([r["outcome"] for r in rows], ["NO", "YES", "NO"])
        self.assertEqual({r["parent_id"] for r in rows}, {"ks:KXBTCD-26SEP3019", "ks:KXETHD-26SEP3019"})
        self.assertEqual([r["symbol"] for r in rows], ["BTCUSDT", "BTCUSDT", "ETHUSDT"])
        self.assertEqual(rows[1]["rules"], "If ... above 95299.99 at 7 PM EDT ... resolves to Yes.\n\nNot all price data is the same.")
        self.assertEqual(rep["skipped"], {"not_above_strike": 1, "not_resolved": 1, "after_window": 1, "other_series": 1})
        self.assertEqual((rep["rows"], rep["parents"], rep["parentsBySymbol"]), (3, 2, {"BTCUSDT": 1, "ETHUSDT": 1}))
        text = "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)
        self.assertEqual(rep["rowsSha256"], hashlib.sha256(text.encode()).hexdigest())

    def test_tampered_page_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            store(root, {"KXBTCD-p200-000": [market("KXBTCD-26SEP3019-T1")]})
            (root / "kalshi" / "KXBTCD-p200-000.json.gz").write_bytes(gzip.compress(b'{"markets": [], "cursor": ""}'))
            with self.assertRaises(ValueError):
                CP.build(root)


class Sample(unittest.TestCase):
    def test_klines_url(self):
        # 2026-09-30T23:00:00Z = 1,790,809,200 s; five 1-minute candles: from 22:55:00 to 22:59:59.999
        self.assertEqual(S.klines_url("BTCUSDT", "2026-09-30T23:00:00Z"),
                         "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=1790808900000&endTime=1790809199999")

    def test_one_market_per_parent_split_by_parent_quota_and_order(self):
        rows = []
        for e in range(400):
            for k in range(3):
                rows.append({**market(f"KXBTCD-26SEP{e:04d}-T{k}"), "market_id": f"ks:KXBTCD-26SEP{e:04d}-T{k}", "parent_id": f"ks:KXBTCD-26SEP{e:04d}",
                             "question": "q", "rules": "r", "closed_at": "2026-09-30T23:00:00Z", "outcome": "YES", "symbol": "BTCUSDT"})
        picked = S.build_crypto(rows)
        self.assertEqual(len({p["parent_id"] for p in picked}), len(picked))
        self.assertTrue(all(split_of(p["parent_id"]) == p["split"] for p in picked))
        c = Counter((p["split"], p["spare"]) for p in picked)
        for s, q in S.CRYPTO_QUOTA.items():
            self.assertEqual(c[(s, False)], min(q, sum(1 for e in range(400) if split_of(f"ks:KXBTCD-26SEP{e:04d}") == s)))
        self.assertEqual(S.build_crypto(rows), picked)  # deterministic
        self.assertTrue(all(p["allowList"] == ["api.binance.com"] and p["pages"][0].startswith(S.BINANCE) for p in picked))


@unittest.skipUnless(CP.ROWS.exists(), "the crypto-price rows are local only (ADJ-39)")
class Dataset(unittest.TestCase):
    def test_committed_report_reproduces(self):
        _, rep = CP.build()
        self.assertEqual(rep, json.loads(CP.REPORT.read_text()))
        text = gzip.decompress(CP.ROWS.read_bytes())
        self.assertEqual(hashlib.sha256(text).hexdigest(), rep["rowsSha256"])


if __name__ == "__main__":
    unittest.main()
