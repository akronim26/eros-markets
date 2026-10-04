"""The pilot sample the panel is run on (plan §10 steps 2-4, tasks O39.3-O39.5).

The historical rows carry no evidence, so a market is usable only if its rules cite sources that can be fetched
now: the panel judges a snapshot of the https URLs its rules cite (O32 snapshotter; the cited hosts are its allow-list),
taken today, long after resolution. The model budget is small (ADJ-46), so the run is a pilot: per category and split
a fixed number of parents, in an order fixed by a hash of (split, parent id) alone, one market per parent (again by
hash). Candidates beyond the quota are listed as spares: the runner moves to the next one when a snapshot holds no
fetchable allow-listed page, without calling any model.

  python3 -m gate.sample      # writes gate/runs/sample.jsonl (local, git-ignored: it holds the rules text, ADJ-39)
  python3 -m gate.sample --run crypto-price   # gate/runs/crypto-price-sample.jsonl (ADJ-50)
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
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


# ---- the crypto-price run (ADJ-50)

CRYPTO_QUOTA = {"train": 15, "calibration": 30, "holdout": 123}  # option B (₹10 cap, ADJ-50): calibration needs 30 parents for real maps
CRYPTO_SPARES = 5
CRYPTO_ORDER = ("calibration", "train", "holdout")  # what the cap reaches first: maps, then θ, then the holdout
BINANCE = "https://api.binance.com/api/v3/klines"
CANDLES = 5  # the 1-minute candles ending at the close: the last opens one minute before it


def klines_url(symbol: str, close_iso: str) -> str:
    from datetime import datetime

    end = int(datetime.fromisoformat(close_iso.replace("Z", "+00:00")).timestamp()) * 1000
    return f"{BINANCE}?symbol={symbol}&interval=1m&startTime={end - CANDLES * 60_000}&endTime={end - 1}"


def build_crypto(rows: list[dict]) -> list[dict]:
    """Per split, parents in a hash-fixed order, one strike per parent (also by hash), the evidence a Binance klines URL."""
    by_parent: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_parent[r["parent_id"]].append(r)
    picked: list[dict] = []
    for s in CRYPTO_ORDER:
        parents = sorted((p for p in by_parent if split_of(p) == s), key=lambda p: order_key("crypto-price", s, p))
        for rank, p in enumerate(parents[: CRYPTO_QUOTA[s] + CRYPTO_SPARES]):
            m = min(by_parent[p], key=lambda r: order_key(p, r["market_id"]))
            url = klines_url(m["symbol"], m["closed_at"])
            picked.append({
                "split": s, "category": "crypto-price", "rank": rank, "spare": rank >= CRYPTO_QUOTA[s], "parent_id": p, "market_id": m["market_id"],
                "question": m["question"], "rules": m["rules"], "closed_at": m["closed_at"], "outcome": m["outcome"],
                "pages": [url], "allowList": ["api.binance.com"],
            })
    return picked


def main() -> None:
    RUNS.mkdir(exist_ok=True)
    if "--run" in sys.argv and sys.argv[sys.argv.index("--run") + 1] == "crypto-price":
        from dataset.crypto_price import ROWS as CRYPTO_ROWS

        sample = build_crypto(read_rows(CRYPTO_ROWS))
        out = RUNS / "crypto-price-sample.jsonl"
    else:
        sample = build(read_rows(DATASET / ROWS))
        out = RUNS / "sample.jsonl"
    out.write_text("".join(json.dumps(x, sort_keys=True) + "\n" for x in sample))
    print(f"wrote {len(sample)} candidates to {out}")


if __name__ == "__main__":
    main()
