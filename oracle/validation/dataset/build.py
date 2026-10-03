"""Normalized dataset from the raw pulls (plan §10 step 1, task O39.1).

Reads raw/MANIFEST.json, checks every file's sha256, and writes
  rows.jsonl.gz  one resolved binary market per line, with its parent and category (gzip, reproducible bytes;
                 local like raw/, ADJ-39: report.json pins its sha256)
  report.json    rows and unique parents per category and source, and what was left out and why

A row's outcome is the market's official resolution: YES, NO or INVALID (a 50/50 resolution). Markets that are
not decisively resolved are left out and counted. All markets of one parent (a Polymarket event, a Kalshi event)
share the parent's category; the holdout split (O39.2) is made by parent.

  python3 -m dataset.build
"""

from __future__ import annotations

import gzip
import hashlib
import json
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .categories import CATEGORIES, PM_PULLS, kalshi_category

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
ROWS = "rows.jsonl.gz"


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in gzip.decompress(path.read_bytes()).decode().splitlines()]


def load_raw(root: Path = RAW) -> tuple[dict, dict[str, object]]:
    """The manifest and every raw document, each checked against its recorded sha256."""
    manifest = json.loads((root / "MANIFEST.json").read_text())
    docs: dict[str, object] = {}
    for f in manifest["files"]:
        body = gzip.decompress((root / f["file"]).read_bytes())
        digest = hashlib.sha256(body).hexdigest()
        if digest != f["sha256"] or len(body) != f["bytes"]:
            raise ValueError(f"{f['file']}: sha256 {digest} does not match the manifest")
        docs[f["file"]] = json.loads(body)
    return manifest, docs


def _decimals(s: object) -> list[Decimal] | None:
    try:
        values = json.loads(s) if isinstance(s, str) else s
        return [Decimal(str(v)) for v in values]
    except (TypeError, ValueError, InvalidOperation, json.JSONDecodeError):
        return None


def pm_outcome(market: dict) -> tuple[str | None, str]:
    """(outcome, reason): YES when the first outcome won, NO when the second did, INVALID on a 50/50."""
    if not market.get("closed"):
        return None, "not_closed"
    try:
        outcomes = json.loads(market.get("outcomes") or "[]")
    except json.JSONDecodeError:
        return None, "bad_outcomes"
    prices = _decimals(market.get("outcomePrices"))
    if len(outcomes) != 2 or prices is None or len(prices) != 2:
        return None, "not_binary"
    one, zero, half = Decimal(1), Decimal(0), Decimal("0.5")
    if prices == [one, zero]:
        return "YES", "ok"
    if prices == [zero, one]:
        return "NO", "ok"
    if prices == [half, half]:
        return "INVALID", "ok"
    return None, "not_resolved"


def ks_outcome(market: dict) -> tuple[str | None, str]:
    if market.get("market_type") != "binary":
        return None, "not_binary"
    result = market.get("result")
    if result == "yes":
        return "YES", "ok"
    if result == "no":
        return "NO", "ok"
    return None, f"result_{result or 'empty'}"


def polymarket_rows(manifest: dict, docs: dict, excluded: Counter) -> list[dict]:
    precedence = {cat_tag: i for i, cat_tag in enumerate((c, t) for c, t, _ in PM_PULLS)}
    best: dict[str, tuple[int, str, dict, str]] = {}  # event id -> (precedence, category, event, raw file)
    for f in manifest["files"]:
        if not f["file"].startswith("polymarket/"):
            continue
        category, tag, _ = f["file"].split("/")[1].split("-", 2)
        rank = precedence[(category, int(tag))]
        for event in docs[f["file"]]:
            eid = str(event["id"])
            if eid not in best or rank < best[eid][0]:
                best[eid] = (rank, category, event, f["file"])
    rows = []
    for eid, (_, category, event, raw_file) in sorted(best.items(), key=lambda kv: int(kv[0])):
        for m in event.get("markets") or []:
            outcome, reason = pm_outcome(m)
            if outcome is None:
                excluded[f"polymarket:{reason}"] += 1
                continue
            outcomes = json.loads(m["outcomes"])
            rows.append({
                "source": "polymarket",
                "market_id": f"pm:{m['id']}",
                "parent_id": f"pm:{eid}",
                "parent_title": event.get("title") or "",
                "question": m.get("question") or "",
                "rules": m.get("description") or event.get("description") or "",
                "resolution_source": m.get("resolutionSource") or event.get("resolutionSource") or "",
                "yes_label": outcomes[0],
                "no_label": outcomes[1],
                "outcome": outcome,
                "category": category,
                "source_category": [t.get("label") for t in event.get("tags") or []],
                "closed_at": m.get("closedTime") or m.get("endDate") or "",
                "raw_file": raw_file,
            })
    return rows


def kalshi_rows(manifest: dict, docs: dict, excluded: Counter) -> list[dict]:
    series_category = {}
    for f in manifest["files"]:
        name = f["file"].split("/")[-1]
        if f["file"].startswith("kalshi/series-"):
            s = docs[f["file"]].get("series") or {}
            series_category[s.get("ticker") or name[len("series-"):-len(".json.gz")]] = s.get("category")
    rows, seen = [], set()
    for f in manifest["files"]:
        if not f["file"].startswith("kalshi/markets-"):
            continue
        for m in docs[f["file"]].get("markets", []):
            if m["ticker"] in seen:
                excluded["kalshi:duplicate"] += 1
                continue
            seen.add(m["ticker"])
            outcome, reason = ks_outcome(m)
            if outcome is None:
                excluded[f"kalshi:{reason}"] += 1
                continue
            series = m["event_ticker"].split("-")[0]
            if series not in series_category:
                excluded["kalshi:no_series"] += 1
                continue
            rules = "\n\n".join(x for x in (m.get("rules_primary"), m.get("rules_secondary")) if x)
            rows.append({
                "source": "kalshi",
                "market_id": f"ks:{m['ticker']}",
                "parent_id": f"ks:{m['event_ticker']}",
                "parent_title": m.get("title") or "",
                "question": " ".join(x for x in (m.get("title"), m.get("yes_sub_title")) if x),
                "rules": rules,
                "resolution_source": "",
                "yes_label": "Yes",
                "no_label": "No",
                "outcome": outcome,
                "category": kalshi_category(series_category[series]),
                "source_category": [series_category[series]],
                "closed_at": m.get("settlement_ts") or m.get("close_time") or "",
                "raw_file": f["file"],
            })
    return rows


def report(rows: list[dict], excluded: Counter, manifest: dict) -> dict:
    parents: dict[str, set] = defaultdict(set)
    by_source: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    row_counts, outcomes = Counter(), defaultdict(Counter)
    for r in rows:
        parents[r["category"]].add(r["parent_id"])
        by_source[r["source"]][r["category"]].add(r["parent_id"])
        row_counts[r["category"]] += 1
        outcomes[r["category"]][r["outcome"]] += 1
    return {
        "schema": "eros-validation-dataset-report/1",
        "params": manifest["params"],
        "rows": len(rows),
        "parents": sum(len(p) for p in parents.values()),
        "perCategory": {
            c: {
                "parents": len(parents[c]),
                "rows": row_counts[c],
                "parentsBySource": {s: len(by_source[s][c]) for s in sorted(by_source)},
                "outcomes": dict(sorted(outcomes[c].items())),
            }
            for c in CATEGORIES
        },
        "excluded": dict(sorted(excluded.items())),
    }


def build(root: Path = RAW, out: Path = HERE) -> dict:
    manifest, docs = load_raw(root)
    excluded: Counter = Counter()
    rows = polymarket_rows(manifest, docs, excluded) + kalshi_rows(manifest, docs, excluded)
    text = "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows)
    (out / ROWS).write_bytes(gzip.compress(text.encode(), mtime=0))
    rep = report(rows, excluded, manifest)
    # The public pins (ADJ-39): rows and raw stay local; these hashes name exactly which data the gate used.
    rep["rowsSha256"] = hashlib.sha256(text.encode()).hexdigest()  # of the JSONL text, independent of zlib
    rep["manifestSha256"] = hashlib.sha256((root / "MANIFEST.json").read_bytes()).hexdigest()
    (out / "report.json").write_text(json.dumps(rep, indent=2) + "\n")
    return rep


if __name__ == "__main__":
    rep = build()
    print(json.dumps({c: v["parents"] for c, v in rep["perCategory"].items()}, indent=2))
    print(f"{rep['rows']} rows, {rep['parents']} parents")
