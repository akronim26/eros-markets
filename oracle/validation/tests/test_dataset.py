"""Task O39.1: the validation dataset (plan §10 step 1).

Two parts. Fixture tests build a tiny raw store by hand and check build.py against rows derived independently
here (parent grouping, category precedence, every resolution rule, the hash check). Dataset tests check the
committed rows.jsonl.gz and report.json: every row has a parent and a category, every parent has one category,
and the parent counts per category are reported (and equal a recount).

  cd oracle/validation && python3 -m unittest tests/test_dataset.py
"""

from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

from dataset import build, snapshot
from dataset.categories import CATEGORIES, kalshi_category

HERE = Path(__file__).resolve().parent.parent / "dataset"


def pm_market(mid, outcomes, prices, closed=True, question="Q?"):
    return {"id": mid, "question": question, "description": f"rules {mid}", "outcomes": json.dumps(outcomes),
            "outcomePrices": json.dumps(prices), "closed": closed, "closedTime": "2026-05-01 00:00:00+00",
            "resolutionSource": ""}


def ks_market(ticker, event, result, mtype="binary"):
    return {"ticker": ticker, "event_ticker": event, "title": f"T {ticker}", "yes_sub_title": "sub",
            "result": result, "market_type": mtype, "rules_primary": "primary", "rules_secondary": "",
            "settlement_ts": "2026-05-02T00:00:00Z"}


class Store:
    """A raw store written the way pull.py writes one."""

    def __init__(self, root: Path):
        self.root, self.files = root, []

    def add(self, rel: str, doc) -> None:
        body = json.dumps(doc).encode()
        (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.root / rel).write_bytes(gzip.compress(body))
        self.files.append({"file": rel, "url": "https://example/" + rel, "fetchedAt": "2026-10-03T00:00:00Z",
                           "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})

    def manifest(self) -> None:
        (self.root / "MANIFEST.json").write_text(json.dumps({"params": {"since": "x"}, "files": self.files, "failures": []}))


def fixture_store(root: Path) -> Store:
    s = Store(root)
    # Event 10 is pulled under Sports and under Elections: Elections comes first in PM_PULLS, so it wins.
    e10 = {"id": "10", "title": "Election night", "tags": [{"label": "Elections"}, {"label": "Sports"}], "markets": [
        pm_market("101", ["Yes", "No"], ["1", "0"]),          # YES
        pm_market("102", ["Yes", "No"], ["0", "1"]),          # NO
    ]}
    e20 = {"id": "20", "title": "Match", "tags": [{"label": "Sports"}], "markets": [
        pm_market("201", ["Lakers", "Celtics"], ["0", "1"]),  # NO (the first outcome lost)
        pm_market("202", ["Yes", "No"], ["0.5", "0.5"]),      # INVALID (50/50)
        pm_market("203", ["Yes", "No"], ["0.62", "0.38"]),    # not resolved: left out
        pm_market("204", ["A", "B", "C"], ["1", "0", "0"]),   # not binary: left out
        pm_market("205", ["Yes", "No"], ["1", "0"], closed=False),  # not closed: left out
    ]}
    s.add("polymarket/sports-1-000.json.gz", [e20, e10])
    s.add("polymarket/elections-144-000.json.gz", [e10])
    s.add("kalshi/markets-000.json.gz", {"markets": [
        ks_market("KXA-1-Y", "KXA-1", "yes"),
        ks_market("KXA-1-N", "KXA-1", "no"),
        ks_market("KXA-1-Y", "KXA-1", "yes"),        # duplicate ticker: left out
        ks_market("KXB-2-V", "KXB-2", ""),           # no result: left out
        ks_market("KXB-2-S", "KXB-2", "yes", "scalar"),  # not binary: left out
        ks_market("KXC-3-Y", "KXC-3", "yes"),        # series without a record: left out
        ks_market("KXD-4-N", "KXD-4", "no"),         # unmapped category -> other
    ]})
    s.add("kalshi/series-KXA.json.gz", {"series": {"ticker": "KXA", "category": "Economics"}})
    s.add("kalshi/series-KXB.json.gz", {"series": {"ticker": "KXB", "category": "Sports"}})
    s.add("kalshi/series-KXD.json.gz", {"series": {"ticker": "KXD", "category": "Entertainment"}})
    s.manifest()
    return s


class FixtureBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = fixture_store(self.root / "raw")
        self.rep = build.build(self.root / "raw", self.root)
        self.rows = build.read_rows(self.root / build.ROWS)

    def tearDown(self):
        self.tmp.cleanup()

    def test_rows_parents_categories_and_outcomes(self):
        got = sorted((r["market_id"], r["parent_id"], r["category"], r["outcome"]) for r in self.rows)
        self.assertEqual(got, sorted([
            ("pm:101", "pm:10", "elections", "YES"),
            ("pm:102", "pm:10", "elections", "NO"),
            ("pm:201", "pm:20", "sports", "NO"),
            ("pm:202", "pm:20", "sports", "INVALID"),
            ("ks:KXA-1-Y", "ks:KXA-1", "macro", "YES"),
            ("ks:KXA-1-N", "ks:KXA-1", "macro", "NO"),
            ("ks:KXD-4-N", "ks:KXD-4", "other", "NO"),
        ]))
        lakers = next(r for r in self.rows if r["market_id"] == "pm:201")
        self.assertEqual((lakers["yes_label"], lakers["no_label"]), ("Lakers", "Celtics"))
        self.assertEqual(next(r for r in self.rows if r["market_id"] == "pm:101")["raw_file"], "polymarket/elections-144-000.json.gz")

    def test_report_counts_parents_per_category_and_exclusions(self):
        per = self.rep["perCategory"]
        self.assertEqual(set(per), set(CATEGORIES))
        self.assertEqual({c: v["parents"] for c, v in per.items() if v["parents"]}, {"elections": 1, "sports": 1, "macro": 1, "other": 1})
        self.assertEqual(per["macro"]["rows"], 2)
        self.assertEqual(per["sports"]["outcomes"], {"INVALID": 1, "NO": 1})
        self.assertEqual(per["macro"]["parentsBySource"], {"kalshi": 1, "polymarket": 0})
        self.assertEqual((self.rep["rows"], self.rep["parents"]), (7, 4))
        self.assertEqual(self.rep["excluded"], {
            "kalshi:duplicate": 1, "kalshi:no_series": 1, "kalshi:not_binary": 1, "kalshi:result_empty": 1,
            "polymarket:not_binary": 1, "polymarket:not_closed": 1, "polymarket:not_resolved": 1,
        })

    def test_a_raw_file_that_does_not_match_its_hash_is_refused(self):
        path = self.root / "raw" / "kalshi" / "markets-000.json.gz"
        path.write_bytes(gzip.compress(b'{"markets": []}'))
        with self.assertRaisesRegex(ValueError, "does not match the manifest"):
            build.load_raw(self.root / "raw")

    def test_kalshi_category_mapping(self):
        self.assertEqual([kalshi_category(c) for c in ("Sports", "Economics", "Financials", "Elections", "Politics", "Crypto", "Companies", "Weather", None)],
                         ["sports", "macro", "macro", "elections", "politics", "crypto", "companies", "other", "other"])


class Snapshot(unittest.TestCase):
    """The raw store as one release asset: byte-reproducible, and refused if the asset or any file changed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        fixture_store(self.root / "raw")

    def tearDown(self):
        self.tmp.cleanup()

    def test_pack_is_deterministic_and_round_trips(self):
        blob = snapshot.pack(self.root / "raw")
        self.assertEqual(blob, snapshot.pack(self.root / "raw"))
        manifest = snapshot.unpack(blob, self.root / "copy", hashlib.sha256(blob).hexdigest())
        self.assertEqual(len(manifest["files"]), 6)
        for f in manifest["files"]:
            self.assertEqual((self.root / "copy" / f["file"]).read_bytes(), (self.root / "raw" / f["file"]).read_bytes())
        # the unpacked store builds the same rows
        rows_a = build.build(self.root / "raw", self.root)["rows"]
        rows_b = build.build(self.root / "copy", self.root)["rows"]
        self.assertEqual(rows_a, rows_b)

    def test_a_changed_asset_or_file_is_refused(self):
        blob = snapshot.pack(self.root / "raw")
        with self.assertRaisesRegex(ValueError, "is not the recorded"):
            snapshot.unpack(blob, self.root / "copy", "0" * 64)
        (self.root / "raw" / "kalshi" / "series-KXA.json.gz").write_bytes(gzip.compress(b'{"series": {"category": "Sports"}}'))
        with self.assertRaisesRegex(ValueError, "does not match the manifest"):
            snapshot.unpack(snapshot.pack(self.root / "raw"), self.root / "copy2")

    def test_snapshot_json_records_the_asset(self):
        blob = snapshot.pack(self.root / "raw")
        snap = snapshot.write_snapshot(blob, self.root, self.root / "raw")
        self.assertEqual(snap["sha256"], hashlib.sha256(blob).hexdigest())
        self.assertEqual(snap["bytes"], len(blob))
        self.assertEqual(snap["url"], "https://github.com/xipharis/eros-markets/releases/download/validation-dataset-v1/raw.tar.gz")
        self.assertEqual(json.loads((self.root / "snapshot.json").read_text()), snap)


@unittest.skipUnless((HERE / build.ROWS).exists(), "no built dataset (run python3 -m dataset.build)")
class CommittedDataset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = build.read_rows(HERE / build.ROWS)
        cls.rep = json.loads((HERE / "report.json").read_text())

    def test_every_row_has_a_parent_and_a_category(self):
        self.assertGreater(len(self.rows), 0)
        for r in self.rows:
            self.assertTrue(r["parent_id"] and r["parent_id"].split(":", 1)[1], r["market_id"])
            self.assertIn(r["category"], CATEGORIES, r["market_id"])
            self.assertIn(r["outcome"], ("YES", "NO", "INVALID"), r["market_id"])
            self.assertTrue(r["question"], r["market_id"])

    def test_every_parent_has_one_category_and_market_ids_are_unique(self):
        cats = defaultdict(set)
        for r in self.rows:
            cats[r["parent_id"]].add(r["category"])
        self.assertEqual([p for p, c in cats.items() if len(c) != 1], [])
        ids = [r["market_id"] for r in self.rows]
        self.assertEqual(len(ids), len(set(ids)))

    def test_parent_counts_are_reported_per_category(self):
        parents = defaultdict(set)
        for r in self.rows:
            parents[r["category"]].add(r["parent_id"])
        self.assertEqual(set(self.rep["perCategory"]), set(CATEGORIES))
        for c in CATEGORIES:
            self.assertEqual(self.rep["perCategory"][c]["parents"], len(parents[c]), c)
        self.assertEqual(self.rep["rows"], len(self.rows))
        self.assertEqual(self.rep["parents"], sum(len(p) for p in parents.values()))

    def test_rows_point_at_raw_files_in_the_manifest(self):
        manifest = json.loads((HERE / "raw" / "MANIFEST.json").read_text()) if (HERE / "raw" / "MANIFEST.json").exists() else None
        if manifest is None:
            self.skipTest("raw store not present")
        files = {f["file"] for f in manifest["files"]}
        self.assertEqual({r["raw_file"] for r in self.rows} - files, set())


if __name__ == "__main__":
    unittest.main()
