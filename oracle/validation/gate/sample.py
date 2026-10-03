"""The pilot sample the panel is run on (plan §10 steps 2-4, tasks O39.3-O39.5).

The historical rows carry no evidence, so a market is usable only if its rules cite sources that can be fetched
now: the panel judges a snapshot of the https URLs its rules cite (O32 snapshotter; the cited hosts are its allow-list),
taken today, long after resolution. The model budget is small (ADJ-46), so the run is a pilot: per category and split
a fixed number of parents, in an order fixed by a hash of (split, parent id) alone, one market per parent (again by
hash). Candidates beyond the quota are listed as spares: the runner moves to the next one when a snapshot holds no
fetchable allow-listed page, without calling any model.

  python3 -m gate.sample      # writes gate/runs/sample.jsonl (local, git-ignored: it holds the rules text, ADJ-39)
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

from dataset.build import HERE as DATASET, ROWS, read_rows
from split.split import SPLITS, split_of

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
SALT = "eros-validation-sample/1"
CATEGORIES = ("macro", "elections")  # the categories whose rules cite the most fetchable sources
QUOTA = {"train": 2, "calibration": 3, "holdout": 3}
SPARES = 4
MAX_PAGES = 4
URL = re.compile(r"https://[^\s)\]\"'<>,]+")
SKIP_HOSTS = {"x.com", "twitter.com", "polymarket-upload.s3.us-east-2.amazonaws.com"}  # login walls and images


def order_key(*parts: str) -> str:
    return hashlib.sha256(":".join((SALT, *parts)).encode()).hexdigest()


def cited_pages(rules: str) -> list[str]:
    out: list[str] = []
    for u in URL.findall(rules):
        u = u.rstrip(".;:")
        host = re.sub(r"^https://([^/?#]+).*", r"\1", u).lower()
        if host not in SKIP_HOSTS and u not in out:
            out.append(u)
    return out[:MAX_PAGES]


def host_of(url: str) -> str:
    return re.sub(r"^https://([^/?#:]+).*", r"\1", url).lower()


def build(rows: list[dict]) -> list[dict]:
    by_parent: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r["category"] in CATEGORIES and r["outcome"] in ("YES", "NO") and cited_pages(r["rules"]):
            by_parent[r["parent_id"]].append(r)
    picked: list[dict] = []
    for cat in CATEGORIES:
        for s in SPLITS:
            parents = sorted((p for p, ms in by_parent.items() if ms[0]["category"] == cat and split_of(p) == s), key=lambda p: order_key(s, p))
            for rank, p in enumerate(parents[: QUOTA[s] + SPARES]):
                m = min(by_parent[p], key=lambda r: order_key(p, r["market_id"]))
                pages = cited_pages(m["rules"])
                picked.append({
                    "split": s, "category": cat, "rank": rank, "spare": rank >= QUOTA[s], "parent_id": p, "market_id": m["market_id"],
                    "question": m["question"], "rules": m["rules"], "closed_at": m["closed_at"], "outcome": m["outcome"],
                    "pages": pages, "allowList": list(dict.fromkeys(host_of(u) for u in pages)),
                })
    return picked


def main() -> None:
    RUNS.mkdir(exist_ok=True)
    sample = build(read_rows(DATASET / ROWS))
    (RUNS / "sample.jsonl").write_text("".join(json.dumps(x, sort_keys=True) + "\n" for x in sample))
    print(f"wrote {len(sample)} candidates to {RUNS / 'sample.jsonl'}")


if __name__ == "__main__":
    main()
