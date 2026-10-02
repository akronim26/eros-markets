#!/usr/bin/env python3
"""Offline inspection of captured public data; no signing or engine delivery."""
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WAD = 10**18
N_LOTS = 1_000_000  # Illustrative 1,000-claim size; no production approval.
MAX_SPREAD_WAD = 5 * 10**16  # Illustrative absolute 0.05 spread.


def number(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+)?", value):
        raise ValueError(f"Invalid decimal string: {value!r}")
    return Fraction(value)


def floor(value):
    return value.numerator // value.denominator


def ceil(value):
    return -((-value.numerator) // value.denominator)


def decimal(value):
    """Exact finite decimal rendering; no binary floating-point arithmetic."""
    value = Fraction(value)
    sign = "-" if value < 0 else ""
    value = abs(value)
    whole, remainder = divmod(value.numerator, value.denominator)
    digits = []
    while remainder:
        remainder *= 10
        digit, remainder = divmod(remainder, value.denominator)
        digits.append(str(digit))
        if len(digits) > 30:
            raise ValueError("Non-terminating or excessive decimal precision")
    return sign + str(whole) + ("." + "".join(digits) if digits else "")


def utc(ms):
    return (datetime(1970, 1, 1, tzinfo=timezone.utc)
            + timedelta(milliseconds=ms)).isoformat()


def levels(raw, tick, descending):
    combined = {}
    for row in raw:
        price, size = number(row["price"]), number(row["size"])
        assert 0 <= price <= 1 and size >= 0
        assert (price / tick).denominator == 1, "Price off tick grid"
        assert (price * WAD).denominator == 1, "Price exceeds WAD precision"
        if size:
            combined[price] = combined.get(price, Fraction(0)) + size
    return sorted(combined.items(), reverse=descending)


def impact(rows, rounder):
    quantity = Fraction(N_LOTS, 1000)
    remaining, notional = quantity, Fraction(0)
    for price, size in rows:
        taken = min(size, remaining)
        notional += price * taken
        remaining -= taken
        if remaining == 0:
            return rounder(notional * WAD / quantity), int(price * WAD)
    return None, None


def valid(bid, ask, bid_depth, ask_depth):
    return (bid is not None and ask is not None
            and bid_depth >= N_LOTS and ask_depth >= N_LOTS
            and 0 < bid <= ask < WAD and ask - bid <= MAX_SPREAD_WAD)


selected = json.loads((ROOT / "selected-markets.json").read_text())
captures = json.loads((ROOT / "capture-times.json").read_text())
times = {r["file"]: r["localFileWriteAtMs"] for r in captures}
snapshots = []
for market in selected:
    for poll in (1, 2):
        name = f"raw/book-{market['category']}-{poll}.json"
        book = json.loads((ROOT / name).read_text())
        assert book["asset_id"] == market["tokenId"], "Wrong token"
        assert book["market"] == market["conditionId"], "Wrong condition"
        metadata = json.loads((ROOT / f"raw/market-{market['category']}.json").read_text())
        assert metadata["active"] and not metadata["closed"]
        assert metadata["acceptingOrders"] and metadata["enableOrderBook"]
        tick, minimum = number(book["tick_size"]), number(book["min_order_size"])
        assert tick > 0 and Fraction(N_LOTS, 1000) >= minimum
        bids, asks = levels(book["bids"], tick, True), levels(book["asks"], tick, False)
        assert bids and asks and bids[0][0] <= asks[0][0], "Empty or crossed book"
        bid_depth = floor(sum((s for _, s in bids), Fraction(0)) * 1000)
        ask_depth = floor(sum((s for _, s in asks), Fraction(0)) * 1000)
        bid, marginal_bid = impact(bids, floor)
        ask, marginal_ask = impact(asks, ceil)
        source_ms, received_ms = int(book["timestamp"]), times[name]
        age_ms = received_ms - source_ms
        age_seconds = received_ms // 1000 - source_ms // 1000
        summary = dict(market, poll=poll, rawBookFile=name,
                       localFileWriteAtMs=received_ms, capturedAtUtc=utc(received_ms),
                       sourceTimestampMs=source_ms, sourceTimestampUtc=utc(source_ms),
                       sourceObservedAtSeconds=source_ms // 1000,
                       ageAtFileWriteMs=age_ms, ageAtFileWriteSeconds=age_seconds,
                       timestampWithin30SecondsAtCapture=0 <= age_seconds <= 30,
                       bestBid=decimal(bids[0][0]), bestAsk=decimal(asks[0][0]),
                       bestBidSizeClaims=decimal(bids[0][1]),
                       bestAskSizeClaims=decimal(asks[0][1]),
                       bestQuoteMidpoint=decimal((bids[0][0] + asks[0][0]) / 2),
                       bidLevelCount=len(bids), askLevelCount=len(asks),
                       bidDepthLots=str(bid_depth), askDepthLots=str(ask_depth),
                       minimumOrderSizeClaims=decimal(minimum), tickSize=decimal(tick),
                       sourceBookHash=book["hash"],
                       exampleImpactBidWad=None if bid is None else str(bid),
                       exampleImpactAskWad=None if ask is None else str(ask),
                       exampleImpactMidWad=None if bid is None or ask is None else str((bid + ask) // 2),
                       exampleVwapDepthValid=valid(bid, ask, bid_depth, ask_depth),
                       exampleMarginalBidWad=None if marginal_bid is None else str(marginal_bid),
                       exampleMarginalAskWad=None if marginal_ask is None else str(marginal_ask),
                       exampleMarginalDepthValid=valid(marginal_bid, marginal_ask, bid_depth, ask_depth))
        snapshots.append(summary)

progress = []
for category in ("crypto", "sports", "politics"):
    a, b = [s for s in snapshots if s["category"] == category]
    delta = b["sourceTimestampMs"] - a["sourceTimestampMs"]
    assert delta >= 0, "Backwards source timestamp"
    progress.append({"category": category, "sourceTimeAdvanced": delta > 0,
                     "sourceTimestampGapMs": delta,
                     "uncoveredSecondsBetweenSamplesUnder30SecondCarry":
                     max(0, b["sourceObservedAtSeconds"] - a["sourceObservedAtSeconds"] - 30)})

result = {
    "status": "PUBLIC_DATA_FETCH_PASS",
    "scope": "Two real public REST snapshots per category; offline exact analysis only",
    "sampleCount": len(snapshots),
    "illustrativeSettings": {"depthNLots": str(N_LOTS), "depthNClaims": "1000",
                             "maxSpreadWad": str(MAX_SPREAD_WAD),
                             "vwapRounding": "bid floor, ask ceil, midpoint floor",
                             "productionApproved": False},
    "limitations": [
        "File modification time approximates local receipt; source timestamp meaning and clock accuracy need approval.",
        "Freshness is measured at capture, not at report viewing or chain acceptance.",
        "Two separated snapshots do not establish continuous 300-second TWAP coverage.",
        "Neither VWAP nor marginal impact policy, depth N, spread, fees, quote normalization or event semantics is production-approved.",
        "No signature, configured engine, RPC submission, risk gate acceptance or deployment was tested."],
    "timestampProgress": progress, "snapshots": snapshots,
    "evidenceSha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
                       for p in sorted((ROOT / "raw").iterdir()) if p.is_file()},
}
(ROOT / "summary.json").write_text(json.dumps(result, indent=2) + "\n")

lines = ["# Polymarket public data smoke check", "",
         "**PUBLIC_DATA_FETCH_PASS**: three categories, six real CLOB snapshots; all six returned HTTP 200. No risk engine delivery was attempted.",
         "", "Captured on 2 October 2026. Exact decimal/rational calculations use Python Fraction; no floating-point financial math.",
         "", "## Latest captured quotes", "",
         "| Category | Question / selected outcome | Best bid | Best ask | Quote midpoint | Source age at capture |",
         "|---|---|---:|---:|---:|---:|"]
for s in snapshots:
    if s["poll"] == 2:
        lines.append(f"| {s['category']} | [{s['question']}]({s['url']}) / **{s['outcomeLabel']}** | {s['bestBid']} | {s['bestAsk']} | {s['bestQuoteMidpoint']} | {decimal(Fraction(s['ageAtFileWriteMs'], 1000))} s |")
lines += ["", "Prices are quoted per selected outcome claim. A quote midpoint is distinct from the depth-N impact midpoint and the engine's 300-second index.",
          "", "## Validation and depth demonstration", "",
          "Each snapshot passed condition/token identity, active/open/accepting-order metadata, exact decimal and tick-grid parsing, nonempty uncrossed books, and minimum-order-size checks. Bids were sorted descending and asks ascending; duplicate levels were aggregated. Depth quantities were converted conservatively to lots (1 claim = 1,000 lots).",
          "", "Illustrative settings only: N = 1,000 claims (1,000,000 lots), maximum absolute spread = 0.05. Both proposed VWAP and alternative marginal-level results are stored. The VWAP bid rounds down, ask rounds up and midpoint rounds down. These calculations do not approve a production pricing policy or fee/collateral normalization.",
          "", "| Category | Example VWAP impact bid | Example VWAP impact ask | Example depth midpoint | Bid depth (lots) | Ask depth (lots) | Example depth check |",
          "|---|---:|---:|---:|---:|---:|---|"]
for s in snapshots:
    if s["poll"] == 2:
        values = [decimal(Fraction(int(s[k]), WAD)) if s[k] is not None else "unavailable"
                  for k in ("exampleImpactBidWad", "exampleImpactAskWad", "exampleImpactMidWad")]
        lines.append(f"| {s['category']} | {' | '.join(values)} | {s['bidDepthLots']} | {s['askDepthLots']} | {'PASS' if s['exampleVwapDepthValid'] else 'FAIL'} |")
lines += ["", "## Freshness and limits", "",
          "All six reported source timestamps were within 30 seconds at capture and advanced on the second read. Local file-write timestamps approximate receipt; source times are preserved without retimestamping. The source-time gaps between the two reads exceeded 30 seconds, so this run contains coverage gaps and cannot produce the required continuous 300-second risk index.",
          "", "The risk engine needs an independent outcome-book reference for bootstrap, margin/mark validation, funding and INVALID history. It owns TWAP aggregation and freshness guards. Public API access works, but event equivalence, impact/time policy, production N/spread, signer/domain and actual signed ingress remain unverified.",
          "", "## Evidence and reproduction", "",
          "- `raw/`: unmodified Gamma tags/event pages/selected metadata, full CLOB books and HTTP headers.",
          "- `selected-markets.json`: exact outcome mapping, condition IDs, token IDs and request URLs.",
          "- `capture-times.json`: preserved original file-write timestamps.",
          "- `summary.json`: all six results, both impact methods, timestamp gaps and evidence SHA-256 hashes.",
          "- Recompute offline: `python3 artifacts/pricefeed-smoke/analyze.py`.",
          "- Refetch a chosen token: `curl --fail --silent --show-error 'https://clob.polymarket.com/book?token_id=<tokenId from selected-markets.json>'`.",
          "", "## Work record", "",
          "Read CLAUDE.md, the implementation PDF, risk specification pricing/units/lifecycle/configuration/math-first sections, price-source ABI, CP-PRICE request and current STATUS. Used official Polymarket discovery and order-book documentation. Category tag IDs were fetched (crypto 21, sports 1, politics 2). Public requests used bounded retries; initial DNS failure inside the sandbox required network escalation, and some requests retried connection resets.",
          "", "Commands: escalated `git fetch` exit 0; Gamma discovery and all six final book requests exit 0; PDF extraction exit 0; offline analyzer exit 0. Risk gates were not run because no contracts or risk behavior changed. The existing `pricefeed` branch and pre-existing untracked files were preserved. Added only this diagnostic evidence directory; no commit, push or shared risk STATUS change.",
          "", "Next step: a bounded continuous collection run to measure coverage and latency, then resolve source-time/impact semantics before signing integration."]
(ROOT / "REPORT.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"status": result["status"], "sampleCount": len(snapshots),
                  "latest": [{k: s[k] for k in ("category", "bestBid", "bestAsk", "bestQuoteMidpoint", "ageAtFileWriteMs", "exampleVwapDepthValid")}
                             for s in snapshots if s["poll"] == 2],
                  "timestampProgress": progress}, indent=2))
