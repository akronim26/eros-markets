"""Raw pulls of resolved Polymarket and Kalshi markets (plan §10 step 1, task O39.1).

Every API response is stored unchanged (gzip) under raw/<source>/ and listed in raw/MANIFEST.json with its URL,
fetch time, byte count and sha256 of the uncompressed bytes, so build.py works from fixed inputs and anyone can
check them. Public endpoints only; no keys. A run is resumable: each page also gets a <file>.meta.json, and a
rerun with the same arguments reuses every page already saved (same URL, same hash) instead of fetching it.

  python3 -m dataset.pull --since 2025-10-01 --until 2026-09-30

Polymarket (Gamma API): closed events per category tag (categories.PM_PULLS), recurring short-interval series
excluded, ending in [since, until). Kalshi (trade API v2): settled markets in [since, until) without multivariate
combos, plus the series records that give each market's category.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .categories import PM_EXCLUDED_TAG_ID, PM_PULLS

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
PM_API = "https://gamma-api.polymarket.com"
KS_API = "https://api.elections.kalshi.com/trade-api/v2"
USER_AGENT = "eros-oracle-validation/1 (+https://github.com/xipharis/eros-markets)"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_json(url: str, tries: int = 6, pause: float = 2.0) -> tuple[bytes, object]:
    """GET a JSON document; empty or non-JSON answers and transport errors are retried with back-off."""
    last = ""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read()
            return body, json.loads(body)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as e:
            last = f"{type(e).__name__}: {e}"
            time.sleep(min(pause * 2**attempt, 30.0))
    raise RuntimeError(f"GET {url} failed after {tries} tries ({last})")


class RawStore:
    """Writes raw responses and their manifest entries."""

    def __init__(self, root: Path = RAW):
        self.root = root
        self.entries: list[dict] = []
        self.failures: list[dict] = []

    def save(self, source: str, name: str, url: str, body: bytes, fetched_at: str | None = None) -> str:
        rel = f"{source}/{name}.json.gz"
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(body, mtime=0))
        entry = {"file": rel, "url": url, "fetchedAt": fetched_at or now_iso(), "bytes": len(body),
                 "sha256": hashlib.sha256(body).hexdigest()}
        (self.root / f"{rel}.meta.json").write_text(json.dumps(entry) + "\n")
        self.entries.append(entry)
        return rel

    def reuse(self, source: str, name: str, url: str) -> object | None:
        """A page an earlier (interrupted) run already saved: its document, recorded again in this manifest.
        A file saved before metadata existed is adopted with this URL (the same request) and its file time."""
        rel = f"{source}/{name}.json.gz"
        path, meta_path = self.root / rel, self.root / f"{rel}.meta.json"
        if not path.exists():
            return None
        body = gzip.decompress(path.read_bytes())
        if meta_path.exists():
            entry = json.loads(meta_path.read_text())
            if entry["url"] != url or entry["sha256"] != hashlib.sha256(body).hexdigest():
                return None  # another request or a damaged file: fetch again
            self.entries.append(entry)
        else:
            mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.save(source, name, url, body, fetched_at=mtime)
        return json.loads(body)

    def fetch(self, source: str, name: str, url: str) -> object:
        """The page from an earlier run when there is one, else fetched now and saved."""
        doc = self.reuse(source, name, url)
        if doc is not None:
            return doc
        body, doc = fetch_json(url)
        self.save(source, name, url, body)
        return doc

    def write_manifest(self, params: dict) -> Path:
        path = self.root / "MANIFEST.json"
        path.write_text(json.dumps({"schema": "eros-validation-raw/1", "params": params, "files": self.entries, "failures": self.failures}, indent=2) + "\n")
        return path


def pull_polymarket(store: RawStore, since: str, until: str, events_per_pull: int) -> None:
    for category, tag_id, label in PM_PULLS:
        fetched, offset, page, failed_in_a_row = 0, 0, 0, 0
        while fetched < events_per_pull:
            q = {
                "closed": "true", "tag_id": tag_id, "exclude_tag_id": PM_EXCLUDED_TAG_ID,
                "end_date_min": f"{since}T00:00:00Z", "end_date_max": f"{until}T00:00:00Z",
                "order": "id", "ascending": "true", "limit": 100, "offset": offset,
            }
            url = f"{PM_API}/events?{urllib.parse.urlencode(q)}"
            try:
                events = store.fetch("polymarket", f"{category}-{tag_id}-{page:03d}", url)
            except RuntimeError as e:  # a page the API keeps failing on (seen: HTTP 500) is skipped and recorded
                store.failures.append({"url": url, "error": str(e), "at": now_iso()})
                failed_in_a_row += 1
                print(f"polymarket {label}: page {page} skipped ({e})", flush=True)
                if failed_in_a_row >= 3:
                    break
                offset += 100
                page += 1
                continue
            failed_in_a_row = 0
            fetched += len(events)
            print(f"polymarket {label}: page {page}, {len(events)} events ({fetched} total)", flush=True)
            if len(events) < 100:
                break
            offset += 100
            page += 1


def pull_kalshi(store: RawStore, since: str, until: str, max_pages: int) -> None:
    ts = lambda d: int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    cursor, series = "", set()
    for page in range(max_pages):
        q = {"status": "settled", "mve_filter": "exclude", "min_settled_ts": ts(since), "max_settled_ts": ts(until), "limit": 1000}
        if cursor:
            q["cursor"] = cursor
        url = f"{KS_API}/markets?{urllib.parse.urlencode(q)}"
        doc = store.fetch("kalshi", f"markets-{page:03d}", url)
        markets = doc.get("markets", [])
        series.update(m["event_ticker"].split("-")[0] for m in markets)
        print(f"kalshi markets: page {page}, {len(markets)} markets, {len(series)} series", flush=True)
        cursor = doc.get("cursor") or ""
        if not cursor or not markets:
            break
        time.sleep(0.2)
    for i, s in enumerate(sorted(series)):
        url = f"{KS_API}/series/{urllib.parse.quote(s)}"
        try:
            store.fetch("kalshi", f"series-{s}", url)
        except RuntimeError as e:  # its markets are left out (build.py counts them as kalshi:no_series)
            store.failures.append({"url": url, "error": str(e), "at": now_iso()})
            continue
        if i % 50 == 0:
            print(f"kalshi series: {i + 1}/{len(series)}", flush=True)
        time.sleep(0.25)  # Kalshi resets connections under bursts (a reused page costs nothing)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", required=True, help="first end/settlement date, YYYY-MM-DD (inclusive)")
    ap.add_argument("--until", required=True, help="last end/settlement date, YYYY-MM-DD (exclusive)")
    ap.add_argument("--pm-events", type=int, default=400, help="Polymarket events per category pull")
    ap.add_argument("--ks-pages", type=int, default=30, help="Kalshi market pages of 1,000")
    a = ap.parse_args(argv)
    store = RawStore()
    pull_polymarket(store, a.since, a.until, a.pm_events)
    pull_kalshi(store, a.since, a.until, a.ks_pages)
    params = {"since": a.since, "until": a.until, "pmEventsPerPull": a.pm_events, "ksPages": a.ks_pages, "pulledAt": now_iso()}
    print(f"wrote {store.write_manifest(params)} ({len(store.entries)} files)")


if __name__ == "__main__":
    main()
