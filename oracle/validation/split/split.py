"""Frozen holdout split by parent (plan §10 step 1, task O39.2).

Every parent market (a Polymarket event, a Kalshi event) goes wholly to one of train, calibration or holdout, never
row by row, so no sibling of a holdout market is seen while tuning. The split is fixed before any tuning (O39.3,
O39.4 read only train and calibration) and needs no stored list: a parent's split is a pure function of its id,

  u = int(sha256("eros-validation-split/1:" + parent_id)[:16 hex], 16) / 2^64   (an exact Fraction)
  train if u < 3/10, calibration if u < 1/2, holdout otherwise

so anyone holding the rows (or only a parent id) recomputes it. The holdout gets half the parents because the gate
needs at least 150 unique parents per category in its high-confidence bucket (§10 step 4). split.json records the
rule, the rows hash it was frozen on (report.json) and per split the parent and row counts per category and
`sha256` of its sorted parent ids, one per line; tests recompute all of it from the rows.

  python3 -m split.split          # writes split/split.json
"""

from __future__ import annotations

import gzip
import hashlib
import json
from collections import defaultdict
from fractions import Fraction
from pathlib import Path

from dataset.build import HERE as DATASET, ROWS, read_rows

HERE = Path(__file__).resolve().parent
SPLIT_FILE = HERE / "split.json"
SALT = "eros-validation-split/1"
SPLITS = ("train", "calibration", "holdout")
BOUNDS = (Fraction(3, 10), Fraction(1, 2))  # train below 3/10, calibration below 1/2, holdout the rest


def unit(parent_id: str) -> Fraction:
    """The parent's position in [0, 1), from its id alone."""
    h = hashlib.sha256(f"{SALT}:{parent_id}".encode()).hexdigest()
    return Fraction(int(h[:16], 16), 2**64)


def split_of(parent_id: str) -> str:
    u = unit(parent_id)
    return "train" if u < BOUNDS[0] else "calibration" if u < BOUNDS[1] else "holdout"


def ids_sha256(ids) -> str:
    return hashlib.sha256("".join(f"{i}\n" for i in sorted(ids)).encode()).hexdigest()


def summarize(rows: list[dict], rows_sha256: str) -> dict:
    parents: dict[str, dict[str, set]] = {s: defaultdict(set) for s in SPLITS}
    nrows: dict[str, dict[str, int]] = {s: defaultdict(int) for s in SPLITS}
    for r in rows:
        s = split_of(r["parent_id"])
        parents[s][r["category"]].add(r["parent_id"])
        nrows[s][r["category"]] += 1
    out = {
        "schema": "eros-validation-split/1",
        "rule": {"salt": SALT, "hash": "sha256", "unitHexDigits": 16,
                 "bounds": {"train": "[0, 3/10)", "calibration": "[3/10, 1/2)", "holdout": "[1/2, 1)"}},
        "rowsSha256": rows_sha256,
        "splits": {},
    }
    for s in SPLITS:
        cats = sorted(parents[s])
        out["splits"][s] = {
            "parents": sum(len(parents[s][c]) for c in cats),
            "rows": sum(nrows[s].values()),
            "parentIdsSha256": ids_sha256(set().union(*parents[s].values()) if cats else set()),
            "perCategory": {c: {"parents": len(parents[s][c]), "rows": nrows[s][c]} for c in cats},
        }
    return out


def rows_of(split: str, rows: list[dict]) -> list[dict]:
    return [r for r in rows if split_of(r["parent_id"]) == split]


def main() -> None:
    report = json.loads((DATASET / "report.json").read_text())
    path = DATASET / ROWS
    if hashlib.sha256(gzip.decompress(path.read_bytes())).hexdigest() != report["rowsSha256"]:
        raise SystemExit("rows.jsonl.gz does not match report.json: rebuild the dataset first")
    SPLIT_FILE.write_text(json.dumps(summarize(read_rows(path), report["rowsSha256"]), indent=2) + "\n")
    print(f"wrote {SPLIT_FILE}")


if __name__ == "__main__":
    main()
