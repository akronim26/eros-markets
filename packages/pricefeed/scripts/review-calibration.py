#!/usr/bin/env python3
"""Independent raw-archive Fraction and time-interval reconstruction. No bot imports.

Usage: review-calibration.py ARCHIVE CALIBRATION_REPORT CONFIGS PLAN [COLLECTOR_REPORT]
Failures exit nonzero. It certifies source-side diagnostic arithmetic only.
"""
from collections import Counter
from fractions import Fraction as F
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

W = 10**18
sha = lambda data: hashlib.sha256(data).hexdigest()
pretty = lambda value: json.dumps(value, ensure_ascii=False, indent=2)
compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def stats(values):
    values = sorted(values)
    rank = lambda p: str(values[(len(values)*p+99)//100-1]) if values else None
    return dict(count=len(values), min=str(values[0]) if values else None,
                p50=rank(50), p95=rank(95), max=str(values[-1]) if values else None)


def decimal(value):
    assert isinstance(value, str) and len(value) <= 100 and re.fullmatch(r'\d+(?:\.\d{1,18})?', value)
    parsed = F(value)
    assert parsed * W <= 2**256-1
    return parsed


def book_summary(raw, n, spread):
    tick, minimum = decimal(raw['tick_size']), decimal(raw['min_order_size'])
    assert 0 < tick <= 1 and minimum > 0
    def levels(side, reverse):
        source = raw[side]
        assert isinstance(source, list) and len(source) <= 10000
        groups = {}
        for level in source:
            p, q = decimal(level['price']), decimal(level['size'])
            assert 0 <= p <= 1 and (p / tick).denominator == 1
            if q:
                groups[p] = groups.get(p, F(0)) + q
                assert groups[p] * W <= 2**256-1
        assert groups
        return sorted(groups.items(), reverse=reverse)
    bids, asks = levels('bids', True), levels('asks', False)
    quantity = F(n, 1000)
    def impact(levels, upwards):
        need, cost = quantity, F(0)
        for price, available in levels:
            take = min(need, available)
            cost += take * price
            need -= take
            if need == 0:
                x = cost * W / quantity
                return -(-x.numerator // x.denominator) if upwards else x.numerator // x.denominator
        return None
    bid, ask = impact(bids, False), impact(asks, True)
    depth_b = int(sum((q for _, q in bids), F(0))*1000)
    depth_a = int(sum((q for _, q in asks), F(0))*1000)
    assert depth_b < 2**256 and depth_a < 2**256
    reason = ('BELOW_SOURCE_MINIMUM' if quantity < minimum else
              'INSUFFICIENT_DEPTH' if bid is None or ask is None else
              'ENDPOINT_PRICE' if bid == 0 or ask >= W else
              'CROSSED_BOOK' if bid > ask or bids[0][0] > asks[0][0] else
              'EXCESSIVE_SPREAD' if ask-bid > spread else None)
    return reason, bid, ask, depth_b, depth_a


def rules(cfg, event, market):
    mapping = cfg['mapping']
    assert event['id'] == mapping['eventId']
    members = [m for m in event['markets'] if m['id'] == mapping['externalMarketId']]
    assert len(members) == 1 and members[0].get('conditionId', mapping['conditionId']) in (None, mapping['conditionId'])
    assert str(market['id']) == mapping['externalMarketId'] and market['conditionId'] == mapping['conditionId']
    decode = lambda x: json.loads(x) if isinstance(x, str) else x
    labels, tokens = decode(market['outcomes']), decode(market['clobTokenIds'])
    assert len(labels) == len(tokens) == len(set(labels)) == len(set(tokens)) == 2
    assert tokens[labels.index(mapping['outcomeLabel'])] == mapping['outcomeTokenId']
    assert isinstance(market['question'], str) and isinstance(market['description'], str)
    ev = dict(id=event['id'], title=event.get('title'), description=event.get('description'),
              resolutionSource=event.get('resolutionSource'), endDate=event.get('endDate'),
              negRisk=event.get('negRisk'), negRiskMarketID=event.get('negRiskMarketID'))
    mk = dict(question=market['question'], description=market['description'], resolutionSource=market.get('resolutionSource'),
              conditionId=market['conditionId'], outcomes=labels, tokens=tokens, eventId=mapping['eventId'],
              endDate=market.get('endDate'), negRisk=market.get('negRisk'), negRiskMarketID=market.get('negRiskMarketID'))
    return sha((sha(compact(ev).encode())+':'+sha(compact(mk).encode())).encode())


def evaluate(rows, cfg, n, spread):
    samples, spreads, depths_b, depths_a = [], [], [], []
    previous, baseline = None, None
    for row in rows:
        inspection = row['inspection']
        reason, expiry = inspection['reason'], None
        if inspection['status'] == 'QUARANTINED' or reason == 'STREAM_RESYNC_REQUIRED':
            samples.append((row, reason or 'QUARANTINED', None)); continue
        if any(row.get(k) is None for k in ['book', 'event', 'metadata']):
            samples.append((row, reason or 'SOURCE_GAP', None)); continue
        raw, event, market = (json.loads(row[k]['body']) for k in ['book', 'event', 'metadata'])
        try:
            digest = rules(cfg, event, market)
        except (AssertionError, KeyError, ValueError, TypeError):
            samples.append((row, 'RAW_EVIDENCE_REJECTED', None)); continue
        assert raw['market'] == cfg['mapping']['conditionId'] and raw['asset_id'] == cfg['mapping']['outcomeTokenId']
        assert isinstance(raw['hash'], str) and raw['hash']
        reason = None
        if baseline is not None and baseline != digest:
            reason = 'SOURCE_RULES_CHANGED'
        else:
            stamp, received = int(raw['timestamp']), int(row['book']['receivedAtMs'])
            assert 0 < stamp and stamp//1000 < 2**64
            try:
                invalid, bid, ask, bd, ad = book_summary(raw, n, spread)
            except (AssertionError, KeyError, ValueError, TypeError):
                # Malformed books must not be hidden by the report.
                raise AssertionError('independent book normalization failed')
            depths_b.append(bd); depths_a.append(ad)
            if bid is not None and ask is not None:
                spreads.append(ask-bid)
            monotone = previous is None or stamp >= previous
            if not monotone: reason = 'BACKWARDS_SOURCE_TIME'
            elif not (event.get('active') is True and event.get('closed') is False and market.get('active') is True
                      and market.get('closed') is False and market.get('enableOrderBook') is True and market.get('acceptingOrders') is True):
                reason = 'SOURCE_NOT_TRADEABLE'
            else:
                metadata_at = min(int(row[k]['receivedAtMs']) for k in ['event', 'metadata'])
                fresh = received-stamp >= 0 and received//1000-stamp//1000 <= 30
                headroom = (stamp//1000+30)*1000-received
                if received < metadata_at or received-metadata_at > cfg['poll']['metadataMaxAgeMs']: reason = 'STALE_METADATA'
                elif not fresh: reason = 'STALE_OR_FUTURE_SOURCE_TIME'
                elif headroom < cfg['poll']['minimumHeadroomMs']: reason = 'INSUFFICIENT_HEADROOM'
                else: reason = invalid
            if monotone: previous = stamp
            if reason is None: expiry = (stamp//1000+30)*1000
        if baseline is None: baseline = digest
        samples.append((row, reason, expiry))
    return samples, spreads, depths_b, depths_a


def review(archive_path, report_path, configs_path, plan_path, collector_path=None):
    archive = Path(archive_path).resolve(strict=True)
    report = json.loads(Path(report_path).read_text()); configs = json.loads(Path(configs_path).read_text())
    plan = json.loads(Path(plan_path).read_text())
    assert report['mode'] == 'READ_ONLY_CATEGORY_CALIBRATION' and report['plan'] == plan
    assert report['productionApproved'] is False and report['engineCoverageCertified'] is False
    assert report['transactionsSent'] == report['signaturesProduced'] == 0
    assert report['sourceArchiveSha256'] == sha(archive.read_bytes())
    assert report['configsSha256'] == sha(pretty(configs).encode())
    if collector_path:
        collector = json.loads(Path(collector_path).read_text())
        assert report['collectorReportSha256'] == sha(Path(collector_path).read_bytes())
        assert collector['sourceArchiveSha256'] == report['sourceArchiveSha256'] and collector['configsSha256'] == report['configsSha256']
        assert not collector['interrupted'] and int(collector['elapsedMs']) >= collector['requestedDurationSeconds']*1000
        restart = collector['restartEvidence']
        assert 0 < restart['capturesBefore'] == restart['capturesAfterReopen']
        assert collector['completedAtMs'] == report['windowEndMs']
    start, end = int(report['windowStartMs']), int(report['windowEndMs'])
    assert end-start == int(plan['windowMs']) == 300000
    db = sqlite3.connect(archive.as_uri()+'?mode=ro', uri=True)
    try: stored = db.execute('select worker,at_ms,payload,sha256 from captures order by id').fetchall()
    finally: db.close()
    rows = []
    for namespace, at, payload, checksum in stored:
        assert sha(payload.encode()) == checksum
        row = json.loads(payload)
        cfg = next(c for c in configs if c['key'] == row['worker'])
        assert cfg['enabled'] is False and cfg['destination'] is None and cfg['pricing']['impactMethod'] == 'vwap'
        assert namespace == 'readonly:'+cfg['mapping']['conditionId']+':'+cfg['mapping']['outcomeTokenId']
        assert at == row['atMs'] and int(at) <= end
        assert row['category'] == cfg['category'] and row['configDigest'] == sha(pretty(cfg).encode())
        assert row['inspection']['engineObservation'] is None
        for field in ['event', 'metadata', 'book']:
            capture = row.get(field)
            if capture:
                assert json.loads(capture['body']) == capture['data'] and 0 <= int(capture['receivedAtMs']) <= int(at)
        rows.append(row)
    assert rows and len(report['markets']) == len(configs)
    cells = 0
    for cfg, actual in zip(configs, report['markets'], strict=True):
        selected = [r for r in rows if r['worker'] == cfg['key']]
        assert selected and actual['worker'] == cfg['key'] and actual['category'] == cfg['category'] and actual['mapping'] == cfg['mapping']
        assert actual['configDigest'] == sha(pretty(cfg).encode()) and actual['captures'] == len(selected)
        assert actual['statusCounts'] == dict(Counter(r['inspection']['status'] for r in selected))
        assert actual['reasonCounts'] == dict(Counter(r['inspection']['reason'] for r in selected if r['inspection']['reason']))
        times = [int(r['atMs']) for r in selected]
        assert times == sorted(times) and actual['firstCaptureMs'] == str(times[0]) and actual['lastCaptureMs'] == str(times[-1])
        ages, headrooms, latency, requests = [], [], [], {}
        previous, advances, repeats = None, 0, 0
        for row in selected:
            for field in ['event', 'metadata', 'book']:
                c = row.get(field)
                if c: requests[field+':'+c['url']+':'+c['receivedAtMs']+':'+sha(c['body'].encode())] = c['attempts']
            if row.get('book'):
                c = row['book']; stamp = int(json.loads(c['body'])['timestamp']); at = int(row['atMs'])
                latency.append(int(c['latencyMs'])); ages.append(at-stamp); headrooms.append((stamp//1000+30)*1000-at)
                if previous is None or stamp > previous: advances += 1
                elif stamp == previous: repeats += 1
                if previous is None or stamp >= previous: previous = stamp
        for field, values in [('sourceAgeAtDecisionMs', ages), ('headroomAtDecisionMs', headrooms), ('bookLatencyMs', latency),
                              ('pollCompletionGapsMs', [b-a for a,b in zip(times, times[1:])])]:
            assert actual[field] == stats(values), field
        assert actual['sourceAdvances'] == advances and actual['sourceRepeats'] == repeats
        assert actual['uniqueRequestCaptures'] == len(requests) and actual['successfulRequestAttempts'] == sum(requests.values())
        index = 0
        for n in plan['depthNLots']:
            for spread in plan['maxSpreadWad']:
                samples, spreads, bd, ad = evaluate(selected, cfg, int(n), int(spread))
                for budget in plan['deliveryBudgetsMs']:
                    failures, remaining = Counter(), []
                    coverage, usable, valid = 0, 0, 0
                    for i, (row, reason, expiry) in enumerate(samples):
                        ready = int(row['atMs'])+int(budget)
                        if expiry is not None:
                            valid += 1
                            if expiry-ready < int(plan['safetyMarginMs']): reason = 'DELIVERY_BUDGET_EXHAUSTED'
                        if reason is None and expiry is not None:
                            usable += 1; remaining.append(expiry-ready)
                            next_time = int(samples[i+1][0]['atMs'])+int(budget) if i+1 < len(samples) else end
                            coverage += max(0, min(next_time, expiry, end)-max(ready, start))
                        else: failures[reason or 'SOURCE_GAP'] += 1
                    expected = dict(depthNLots=n, maxSpreadWad=spread, deliveryBudgetMs=budget, validBooks=valid,
                                    usableCaptures=usable, reasonCounts=dict(failures), projectedCoverageMs=str(coverage),
                                    projectedCoverageBps=str(coverage*10000//300000), headroomAfterBudgetMs=stats(remaining),
                                    impactSpreadWad=stats(spreads), bidDepthLots=stats(bd), askDepthLots=stats(ad))
                    assert actual['candidates'][index] == expected, (cfg['key'], n, spread, budget)
                    index += 1; cells += 1
        assert len(actual['candidates']) == index
    return dict(verified=True, method='Independent Python Fraction/raw-SQLite/time-interval reconstruction; no bot imports',
                capturesChecked=len(rows), marketsChecked=len(configs), gridCellsChecked=cells,
                sourceArchiveSha256=report['sourceArchiveSha256'], reportSha256=sha(Path(report_path).read_bytes()),
                engineCoverageCertified=False, productionApproved=False, transactionsSent=0, signaturesProduced=0)


if __name__ == '__main__':
    if len(sys.argv) not in (5, 6): raise SystemExit('ARCHIVE_REPORT_CONFIGS_PLAN_REQUIRED')
    print(json.dumps(review(*sys.argv[1:]), indent=2))
