#!/usr/bin/env python3
"""Bounded public API diagnostic. Never signs, sends transactions or edits contracts."""
import concurrent.futures
import hashlib
import json
import re
import subprocess
import time
from fractions import Fraction as F
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE / "timed-run"
ROOT.mkdir(exist_ok=True)
RAW = ROOT / "raw"
RAW.mkdir(exist_ok=True)
MARKETS = json.loads((BASE.parent / "pricefeed-smoke/selected-markets.json").read_text())
DURATION_NS = 600 * 10**9
INTERVAL_NS = 10 * 10**9
N = F(1000)  # Diagnostic size only; not approved calibration.
WAD = 10**18
previous = {}
metadata = {}


def read_json(url, category, poll, kind):
    path = RAW / f"{category}-{poll:03}-{kind}.json"
    before = time.time_ns() // 10**6
    started = time.monotonic_ns()
    result = subprocess.run(["curl", "--silent", "--show-error", "--fail",
                             "--max-time", "6", "--max-filesize", "2000000",
                             "--dump-header", str(path.with_suffix(".headers")),
                             "--output", str(path), "--write-out", "%{http_code}", url],
                            capture_output=True, text=True, timeout=8)
    received = time.time_ns() // 10**6
    record = {"url": url, "category": category, "poll": poll, "kind": kind,
              "requestAtMs": before, "receivedAtMs": received,
              "latencyMs": (time.monotonic_ns() - started) // 10**6,
              "curlExitCode": result.returncode, "httpStatus": result.stdout,
              "rawFile": str(path.relative_to(ROOT)), "error": result.stderr.strip()}
    if result.returncode:
        return record, None
    body = path.read_bytes()
    record["bodySha256"] = hashlib.sha256(body).hexdigest()
    return record, json.loads(body)


def parse(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+)?", value):
        raise ValueError("Malformed decimal string")
    return F(value)


def normalize(rows, tick, reverse):
    aggregate = {}
    for row in rows:
        price, size = parse(row["price"]), parse(row["size"])
        if not (0 <= price <= 1 and size >= 0 and (price / tick).denominator == 1
                and (price * WAD).denominator == 1):
            raise ValueError("Invalid price, size, grid or WAD precision")
        if size:
            aggregate[price] = aggregate.get(price, F(0)) + size
    return sorted(aggregate.items(), reverse=reverse)


def impact(rows, ask):
    left, notional = N, F(0)
    for price, size in rows:
        take = min(left, size)
        notional += price * take
        left -= take
        if left == 0:
            exact = notional * WAD / N
            return -(-exact.numerator // exact.denominator) if ask else exact.numerator // exact.denominator
    return None


def sample(market, poll):
    category = market["category"]
    records = []
    try:
        if poll % 6 == 0:
            record, body = read_json("https://gamma-api.polymarket.com/markets/" + market["marketId"], category, poll, "metadata")
            records.append(record)
            if body is not None:
                metadata[category] = (body, record["receivedAtMs"])
        record, book = read_json(market["bookUrl"], category, poll, "book")
        records.append(record)
        if book is None:
            record["diagnosticEligible"] = False
            return records
        if book["asset_id"] != market["tokenId"] or book["market"] != market["conditionId"]:
            raise ValueError("Condition/token identity mismatch")
        timestamp = book["timestamp"]
        if not isinstance(timestamp, str) or not timestamp.isdigit():
            raise ValueError("Missing or malformed source timestamp")
        source_ms = int(timestamp)
        source_s = source_ms // 1000
        received_s = record["receivedAtMs"] // 1000
        tick, minimum = parse(book["tick_size"]), parse(book["min_order_size"])
        if tick <= 0 or minimum <= 0:
            raise ValueError("Invalid order constraints")
        bids, asks = normalize(book["bids"], tick, True), normalize(book["asks"], tick, False)
        if not bids or not asks:
            raise ValueError("Empty book side")
        bid, ask = impact(bids, False), impact(asks, True)
        depth_ok = (bid is not None and ask is not None and 0 < bid <= ask < WAD
                    and ask - bid <= 5 * 10**16 and N >= minimum)
        age = record["receivedAtMs"] - source_ms
        fresh = 0 <= received_s - source_s <= 30 and age >= 0
        old_time = previous.get(category)
        monotone = old_time is None or source_ms >= old_time
        previous[category] = max(source_ms, old_time or source_ms)
        meta, meta_received = metadata.get(category, ({}, 0))
        labels = json.loads(meta.get("outcomes", "[]"))
        tokens = json.loads(meta.get("clobTokenIds", "[]"))
        mapped = (market["outcomeLabel"] in labels
                  and len(labels) == len(tokens)
                  and tokens[labels.index(market["outcomeLabel"])] == market["tokenId"])
        status_ok = (mapped and meta.get("conditionId") == market["conditionId"]
                     and meta.get("active") and not meta.get("closed")
                     and meta.get("enableOrderBook") and meta.get("acceptingOrders")
                     and record["receivedAtMs"] - meta_received <= 90000)
        record.update(sourceTimestampMs=source_ms, sourceObservedAtSeconds=source_s,
                      sourceAgeMs=age, sourceFreshAtReceipt=fresh, sourceTimeMonotone=monotone,
                      sourceTimestampAdvanced=old_time is None or source_ms > old_time,
                      metadataStatusValid=bool(status_ok),
                      bestBidWad=str(int(bids[0][0] * WAD)), bestAskWad=str(int(asks[0][0] * WAD)),
                      bidDepthLots=str(int(sum((s for _, s in bids), F(0)) * 1000)),
                      askDepthLots=str(int(sum((s for _, s in asks), F(0)) * 1000)),
                      exampleImpactBidWad=None if bid is None else str(bid),
                      exampleImpactAskWad=None if ask is None else str(ask),
                      exampleMidWad=None if not depth_ok else str((bid + ask) // 2),
                      exampleDepthValid=depth_ok, sourceBookHash=book["hash"],
                      diagnosticEligible=bool(depth_ok and fresh and monotone and status_ok))
    except Exception as exc:
        if records:
            records[-1]["validationError"] = f"{type(exc).__name__}: {exc}"
            records[-1]["diagnosticEligible"] = False
        else:
            records.append({"category": category, "poll": poll, "kind": "book",
                            "receivedAtMs": time.time_ns() // 10**6,
                            "validationError": f"{type(exc).__name__}: {exc}",
                            "diagnosticEligible": False})
    return records


start_wall_ms = time.time_ns() // 10**6
start = time.monotonic_ns()
all_records = []
print(json.dumps({"state": "started", "durationSeconds": 600, "targetIntervalSeconds": 10,
                  "startedAtMs": start_wall_ms, "markets": [m["category"] for m in MARKETS]}), flush=True)
with (ROOT / "observations.jsonl").open("w") as log, concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for poll in range(61):
        delay = start + poll * INTERVAL_NS - time.monotonic_ns()
        if delay > 0:
            time.sleep(delay / 10**9)
        futures = [pool.submit(sample, market, poll) for market in MARKETS]
        for future in futures:
            for record in future.result():
                all_records.append(record)
                log.write(json.dumps(record) + "\n")
        log.flush()
        if poll == 0 and all(r.get("curlExitCode") == 6 for r in all_records if r["kind"] == "book"):
            raise RuntimeError("All first reads failed DNS resolution; rerun with authorized network access")
        if poll % 6 == 0:
            books = [r for r in all_records if r["kind"] == "book"]
            print(json.dumps({"poll": poll, "elapsedSeconds": (time.monotonic_ns() - start) // 10**9,
                              "bookAttempts": len(books),
                              "http200": sum(r.get("httpStatus") == "200" for r in books),
                              "fresh": sum(r.get("sourceFreshAtReceipt", False) for r in books),
                              "eligible": sum(r.get("diagnosticEligible", False) for r in books)}), flush=True)
manifest = {"startedAtMs": start_wall_ms, "finishedAtMs": time.time_ns() // 10**6,
            "targetDurationSeconds": 600, "targetIntervalSeconds": 10,
            "pollCount": 61, "requests": len(all_records),
            "illustrativeDepthNClaims": "1000", "illustrativeMaxSpreadWad": str(5 * 10**16),
            "productionApproved": False, "transactionsSent": 0, "signaturesProduced": 0}
(ROOT / "run-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
(ROOT / "all-records.json").write_text(json.dumps(all_records, indent=2) + "\n")
print(json.dumps({"state": "finished", **manifest}), flush=True)
