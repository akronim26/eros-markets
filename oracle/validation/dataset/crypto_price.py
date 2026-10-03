"""Crypto price-threshold markets for the crypto-price category (plan §10 step 1, ADJ-47).

The main dataset (O39.1) holds only 78 holdout parents of Kalshi's crypto price-threshold events, below the 150 the
gate needs, so this pulls those events on their own: settled markets of Kalshi's "<asset> price at <time>" series
(KXBTCD, KXETHD, ...: YES when the CF Benchmarks index's 60-second average before the time is above the strike),
stored and pinned like the main pull (raw responses gzipped with sha256 sidecars, a manifest, rows and a report),
local and git-ignored except the manifest and the report (ADJ-39). Same window as O39.1 (closing before
2026-10-01). A parent is a Kalshi event (one asset at one time); its markets are the strikes.

Each row also carries what the evidence fetch needs: the Binance spot symbol for the asset and the close time. The
split is O39.2's rule on the parent id, so these parents fall into train, calibration and holdout the same way.

  python3 -m dataset.crypto_price            # pull (resumable) and build
"""

from __future__ import annotations

import gzip
import hashlib
import json
import time
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .pull import KS_API, RawStore, fetch_json

HERE = Path(__file__).resolve().parent / "crypto-price"
RAW = HERE / "raw"
ROWS = HERE / "rows.jsonl.gz"
REPORT = HERE / "report.json"
UNTIL = "2026-10-01T00:00:00Z"
PAGES = 50  # of 200 markets: large pages get their connection reset by the public API
PAGE_SIZE = 200
SERIES = {  # Kalshi series → Binance spot symbol
    "KXBTCD": "BTCUSDT", "KXETHD": "ETHUSDT", "KXSOLD": "SOLUSDT", "KXXRPD": "XRPUSDT",
    "KXDOGED": "DOGEUSDT", "KXBNBD": "BNBUSDT", "KXHYPED": "HYPEUSDT", "KXSHIBAD": "SHIBUSDT",
}


def ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def pull(store: RawStore, pages: int = PAGES) -> None:
    until = ts(UNTIL)
    for series in SERIES:
        cursor = ""
        for page in range(pages):
            q = {"series_ticker": series, "status": "settled", "limit": str(PAGE_SIZE), "max_close_ts": str(until)}
            if cursor:
                q["cursor"] = cursor
            url = f"{KS_API}/markets?{urllib.parse.urlencode(q)}"
            name = f"{series}-p{PAGE_SIZE}-{page:03d}"
            doc = store.reuse("kalshi", name, url)
            if doc is None:  # the public API resets about two connections in three from here: retry patiently
                body, doc = fetch_json(url, tries=30, pause=1.0)
                store.save("kalshi", name, url, body)
            time.sleep(1)  # gentle on the public API (deep pages reset the connection when hurried)
            cursor = doc.get("cursor") or ""
            if not cursor or not doc.get("markets"):
                break


def build(root: Path = RAW) -> tuple[list[dict], dict]:
    manifest = json.loads((root / "MANIFEST.json").read_text())
    rows, skipped = [], Counter()
    for f in manifest["files"]:
        body = gzip.decompress((root / f["file"]).read_bytes())
        if hashlib.sha256(body).hexdigest() != f["sha256"]:
            raise ValueError(f"{f['file']}: sha256 does not match the manifest")
        for m in json.loads(body)["markets"]:
            series = m["event_ticker"].split("-")[0]
            if series not in SERIES:
                skipped["other_series"] += 1
            elif m.get("strike_type") != "greater" or m.get("floor_strike") is None:
                skipped["not_above_strike"] += 1
            elif m.get("result") not in ("yes", "no"):
                skipped["not_resolved"] += 1
            elif ts(m["close_time"]) >= ts(UNTIL):
                skipped["after_window"] += 1
            else:
                rows.append({
                    "category": "crypto-price", "source": "kalshi", "parent_id": f"ks:{m['event_ticker']}", "market_id": f"ks:{m['ticker']}",
                    "question": f"{m.get('title', '')} {m.get('yes_sub_title', '')}".strip(),
                    "rules": "\n\n".join(x for x in (m.get("rules_primary", ""), m.get("rules_secondary", "")) if x),
                    "closed_at": m["close_time"], "outcome": m["result"].upper(), "strike": str(m["floor_strike"]),
                    "symbol": SERIES[series], "raw_file": f["file"],
                })
    rows = list({r["market_id"]: r for r in rows}.values())  # a market seen on two pages counts once
    rows.sort(key=lambda r: r["market_id"])
    parents: dict[str, set] = defaultdict(set)
    for r in rows:
        parents[r["symbol"]].add(r["parent_id"])
    text = "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)
    report = {
        "schema": "eros-validation-crypto-price/1", "until": UNTIL, "series": SERIES, "rows": len(rows),
        "parents": len({r["parent_id"] for r in rows}), "parentsBySymbol": {s: len(v) for s, v in sorted(parents.items())},
        "outcomes": dict(Counter(r["outcome"] for r in rows)), "skipped": dict(skipped),
        "rowsSha256": hashlib.sha256(text.encode()).hexdigest(),
        "manifestSha256": hashlib.sha256((root / "MANIFEST.json").read_bytes()).hexdigest(),
    }
    return rows, report


def main() -> None:
    store = RawStore(RAW)
    pull(store)
    (RAW / "MANIFEST.json").write_text(json.dumps({"files": sorted(store.entries, key=lambda e: e["file"]), "failures": store.failures}, indent=1) + "\n")
    rows, report = build()
    ROWS.write_bytes(gzip.compress("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows).encode(), mtime=0))
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{report['rows']} rows, {report['parents']} parents: {report['parentsBySymbol']}")


if __name__ == "__main__":
    main()
