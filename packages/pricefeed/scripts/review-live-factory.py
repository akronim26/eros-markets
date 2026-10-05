#!/usr/bin/env python3
"""Independent Fraction/raw-source replay of a closed live full-engine archive."""
import hashlib
import json
import runpy
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
HELPERS = runpy.run_path(str(PACKAGE / "scripts/review-pipeline.py"))
CALIBRATION = runpy.run_path(str(PACKAGE / "scripts/review-calibration.py"))


def replay(items, checkpoint):
    samples = {}
    for item in items:
        if int(item["accepted"]["blockNumber"]) > int(checkpoint["number"]):
            continue
        observation = item["packet"]["observation"]
        samples[int(observation["observedAt"])] = (int(observation["priceWad"]), item["accepted"]["depthValid"])
    end, covered, integral = int(checkpoint["timestamp"]), 0, 0
    ordered = sorted(samples.items())
    for index, (at, (price, valid)) in enumerate(ordered):
        if not valid:
            continue
        until = min(end, at + 30, ordered[index + 1][0] if index + 1 < len(ordered) else end)
        span = max(0, until - max(at, end - 300))
        covered += span
        integral += span * price
    return {"available": covered == 300, "coveredSecs": str(covered), "integral": str(integral),
            "twapWad": str(integral // 300 if covered == 300 else 0)}


def review(path):
    report = json.loads(path.read_text(encoding="utf8"))
    assert report["mode"] == "LOCAL_LIVE_FACTORY_PRICEFEED_AUDIT" and report["passed"] is True
    assert report["chainId"] == 31337 and report["externalChainTransactions"] == 0 and report["productionApproved"] is False
    config, archive = report["config"], Path(report["archive"])
    assert config["enabled"] is False and config["destination"]["chainId"] == "31337"
    assert set(report["archiveSha256"]) == {"source.sqlite", "packets.sqlite", "signer.sqlite", "transactions.sqlite", "relay.sqlite"}
    for name, expected in report["archiveSha256"].items():
        assert hashlib.sha256((archive / name).read_bytes()).hexdigest() == expected, name
    sources = list(HELPERS["records"](archive / "source.sqlite", "captures", "payload"))
    packet_records = {row["observation"]["sequence"]: row for row in HELPERS["records"](archive / "packets.sqlite", "packets", "body")}
    deliveries = {row["sequence"]: row for row in HELPERS["records"](archive / "relay.sqlite", "deliveries", "body")}
    by_time = {}
    for source in sources:
        if source.get("book"):
            book = json.loads(source["book"]["body"])
            if "timestamp" in book:
                by_time.setdefault(str(book["timestamp"]), []).append((book, source))
    previous_sequence, previous_source, nonces = 0, 0, set()
    for item in report["accepted"]:
        packet, delivery, accepted = item["packet"], item["delivery"], item["accepted"]
        observation = packet["observation"]
        sequence, source_ms = int(observation["sequence"]), int(packet["sourceMs"])
        assert packet == packet_records[str(sequence)] and delivery == deliveries[str(sequence)]
        assert sequence > previous_sequence and source_ms >= previous_source
        previous_sequence, previous_source = sequence, source_ms
        assert int(observation["observedAt"]) == source_ms // 1000
        assert int(observation["observedAt"]) <= int(observation["publishedAt"]) <= int(accepted["acceptedAt"])
        assert int(accepted["acceptedAt"]) - int(observation["observedAt"]) <= 30
        assert delivery["nonce"] not in nonces
        nonces.add(delivery["nonce"])
        matched = False
        for book, source in by_time.get(str(source_ms), []):
            assert book["asset_id"] == config["mapping"]["outcomeTokenId"] and book["market"] == config["mapping"]["conditionId"]
            rules_digest = CALIBRATION["rules"](config, json.loads(source["event"]["body"]), json.loads(source["metadata"]["body"]))
            assert "0x" + rules_digest == report["sourceRules"]["externalRulesDigest"]
            reason, bid, ask, bid_depth, ask_depth = CALIBRATION["book_summary"](
                book, int(config["pricing"]["depthNLots"]), int(config["pricing"]["maxSpreadWad"]))
            valid = reason is None
            expected = {"bidDepthLots": bid_depth, "askDepthLots": ask_depth, "impactBidWad": bid if valid else 0,
                        "impactAskWad": ask if valid else 0, "priceWad": (bid + ask) // 2 if valid else 0}
            if all(int(observation[key]) == value for key, value in expected.items()):
                assert accepted["depthValid"] == valid and int(accepted["priceWad"]) == expected["priceWad"]
                assert accepted["digest"] == item["digest"] == delivery["digest"]
                assert accepted["transactionHash"] == delivery["txHash"]
                matched = True
                break
        assert matched, f"packet {sequence} lacks a matching authentic source book"
    assert len(nonces) == report["publisherReceiptCount"] == len(report["publisherReceipts"])
    expected = replay(report["accepted"], report["checkpoint"])
    assert expected == report["actualIndexTwap"], "historical INDEX window does not match authentic accepted source intervals"
    return {"passed": True, "mode": "INDEPENDENT_LIVE_FACTORY_FRACTION_REPLAY", "audit": str(path),
            "acceptedPackets": len(nonces), "rawCaptures": len(sources), "authenticSourceTimesVerified": True,
            "fractionPricesAndDepthVerified": True, "archiveHashesVerified": True,
            "historicalIndexTwap": expected, "canonicalReceiptAudit": report["canonicalReceiptsVerified"],
            "samplerReceiptCount": report["samplerReceiptCount"], "productionApproved": False}


if __name__ == "__main__":
    assert len(sys.argv) == 2, "usage: review-live-factory.py AUDIT_JSON"
    print(json.dumps(review(Path(sys.argv[1]).resolve()), indent=2))
