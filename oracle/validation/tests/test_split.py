"""Task O39.2: the frozen holdout split (plan §10 step 1).

Fixture tests check the rule on hand-made rows: whole parents per split, positions recomputed here from sha256
independently of split.py, and the summary's counts and hashes. Dataset tests check that the committed split.json
was frozen on the pinned rows and that every number and hash in it reproduces from the rows (they skip where the
local-only rows are absent, ADJ-39).

  cd oracle/validation && python3 -m unittest tests/test_split.py
"""

from __future__ import annotations

import gzip
import hashlib
import json
import unittest
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

from dataset.build import read_rows
from split import split

ROOT = Path(__file__).resolve().parent.parent
ROWS = ROOT / "dataset" / "rows.jsonl.gz"
REPORT = json.loads((ROOT / "dataset" / "report.json").read_text())
COMMITTED = json.loads((ROOT / "split" / "split.json").read_text())


def position(parent_id: str) -> Fraction:
    digest = hashlib.sha256(("eros-validation-split/1:" + parent_id).encode()).digest()
    return Fraction(int.from_bytes(digest[:8], "big"), 1 << 64)


def expected_split(parent_id: str) -> str:
    u = position(parent_id)
    return "train" if u * 10 < 3 else "calibration" if u * 2 < 1 else "holdout"


def fixture_rows() -> list[dict]:
    rows = []
    for p in range(60):
        for m in range(1 + p % 4):  # parents with 1 to 4 markets
            rows.append({"parent_id": f"pm:{p}", "market_id": f"pm:{p}-{m}", "category": ["sports", "macro", "crypto"][p % 3]})
    return rows


class Rule(unittest.TestCase):
    def test_position_matches_an_independent_computation(self):
        for p in ["pm:1", "ks:KXDJI-26SEP3014", "pm:14375", ""]:
            self.assertEqual(split.unit(p), position(p))
            self.assertEqual(split.split_of(p), expected_split(p))

    def test_known_values(self):
        # sha256("eros-validation-split/1:pm:1") computed by hand with hashlib, first 8 bytes as the numerator
        h = hashlib.sha256(b"eros-validation-split/1:pm:1").hexdigest()[:16]
        self.assertEqual(split.unit("pm:1"), Fraction(int(h, 16), 2**64))

    def test_boundaries_are_half_open(self):
        orig = split.unit
        try:
            for u, want in [(Fraction(0), "train"), (Fraction(3, 10) - Fraction(1, 2**64), "train"), (Fraction(3, 10), "calibration"),
                            (Fraction(1, 2) - Fraction(1, 2**64), "calibration"), (Fraction(1, 2), "holdout"), (Fraction(2**64 - 1, 2**64), "holdout")]:
                split.unit = lambda _p, u=u: u
                self.assertEqual(split.split_of("x"), want, u)
        finally:
            split.unit = orig

    def test_whole_parents_and_counts_on_fixture_rows(self):
        rows = fixture_rows()
        s = split.summarize(rows, "ab" * 32)
        where = defaultdict(set)
        for name in split.SPLITS:
            for r in split.rows_of(name, rows):
                where[r["parent_id"]].add(name)
        self.assertTrue(all(len(v) == 1 for v in where.values()))  # no parent in two splits
        self.assertEqual(len(where), 60)
        self.assertEqual(sum(v["rows"] for v in s["splits"].values()), len(rows))
        for name in split.SPLITS:
            mine = {p for p, v in where.items() if v == {name}}
            self.assertEqual(s["splits"][name]["parents"], len(mine))
            self.assertEqual(s["splits"][name]["parentIdsSha256"], hashlib.sha256("".join(p + "\n" for p in sorted(mine)).encode()).hexdigest())
            for cat, c in s["splits"][name]["perCategory"].items():
                self.assertEqual(c["parents"], len({r["parent_id"] for r in rows if r["category"] == cat and expected_split(r["parent_id"]) == name}))
                self.assertEqual(c["rows"], sum(1 for r in rows if r["category"] == cat and expected_split(r["parent_id"]) == name))
        self.assertEqual(s["rowsSha256"], "ab" * 32)


@unittest.skipUnless(ROWS.exists(), "the dataset is local only (ADJ-39)")
class Dataset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = gzip.decompress(ROWS.read_bytes())
        cls.rows = read_rows(ROWS)

    def test_frozen_on_the_pinned_rows(self):
        self.assertEqual(hashlib.sha256(self.text).hexdigest(), REPORT["rowsSha256"])
        self.assertEqual(COMMITTED["rowsSha256"], REPORT["rowsSha256"])

    def test_committed_split_reproduces(self):
        self.assertEqual(split.summarize(self.rows, REPORT["rowsSha256"]), COMMITTED)

    def test_no_parent_in_two_splits(self):
        seen: dict[str, str] = {}
        for r in self.rows:
            s = expected_split(r["parent_id"])
            self.assertEqual(seen.setdefault(r["parent_id"], s), s)
        ids = {name: set() for name in split.SPLITS}
        for p, s in seen.items():
            ids[s].add(p)
        self.assertFalse(ids["train"] & ids["calibration"] or ids["train"] & ids["holdout"] or ids["calibration"] & ids["holdout"])
        self.assertEqual(sum(len(v) for v in ids.values()), REPORT["parents"])

    def test_every_category_in_every_split(self):
        for name in split.SPLITS:
            self.assertEqual(set(COMMITTED["splits"][name]["perCategory"]), set(REPORT["perCategory"]))


class Pins(unittest.TestCase):
    def test_counts_add_up_to_the_report(self):
        for cat, c in REPORT["perCategory"].items():
            self.assertEqual(sum(COMMITTED["splits"][s]["perCategory"][cat]["parents"] for s in split.SPLITS), c["parents"])
            self.assertEqual(sum(COMMITTED["splits"][s]["perCategory"][cat]["rows"] for s in split.SPLITS), c["rows"])

    def test_rule_recorded(self):
        self.assertEqual(COMMITTED["rule"]["salt"], split.SALT)
        self.assertEqual(split.BOUNDS, (Fraction(3, 10), Fraction(1, 2)))


if __name__ == "__main__":
    unittest.main()
