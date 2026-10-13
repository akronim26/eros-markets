#!/usr/bin/env python3
"""Offline independent Fraction review of a closed local-pipeline archive."""
import hashlib
import json
import sqlite3
import sys
from fractions import Fraction
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
WAD = 10**18


def records(path, table, body):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        for value, checksum in db.execute(f"SELECT {body},sha256 FROM {table}"):
            assert hashlib.sha256(value.encode()).hexdigest() == checksum, f"{table} checksum"
            yield json.loads(value)


def impact(levels, quantity, descending):
    remaining, cost = quantity, Fraction(0)
    for price, size in sorted(levels, reverse=descending):
        take = min(size, remaining)
        cost += price * take
        remaining -= take
        if remaining == 0:
            return cost / quantity
    return None


def summary(book, config):
    bids = [(Fraction(x['price']), Fraction(x['size'])) for x in book['bids']]
    asks = [(Fraction(x['price']), Fraction(x['size'])) for x in book['asks']]
    bid_depth = sum((s for _, s in bids), Fraction(0)) * 1000
    ask_depth = sum((s for _, s in asks), Fraction(0)) * 1000
    n = Fraction(int(config['pricing']['depthNLots']), 1000)
    bid, ask = impact(bids, n, True), impact(asks, n, False)
    bid_wad = int(bid * WAD) if bid is not None else 0
    a = ask * WAD if ask is not None else Fraction(0)
    ask_wad = -(-a.numerator // a.denominator)
    valid = (bid is not None and ask is not None and 0 < bid_wad <= ask_wad < WAD
             and ask_wad - bid_wad <= int(config['pricing']['maxSpreadWad']))
    # The selected local invalid policy transmits zero impacts, retaining real depths.
    return {'bidDepthLots': int(bid_depth), 'askDepthLots': int(ask_depth),
            'impactBidWad': bid_wad if valid else 0,
            'impactAskWad': ask_wad if valid else 0,
            'priceWad': (bid_wad + ask_wad) // 2 if valid else 0}, valid


def review(path):
    report = json.loads(path.read_text())
    assert report['chainId'] == 31337 and report['externalChainTransactions'] == 0
    assert report['productionApproved'] is False and report['config']['enabled'] is False
    archive = (PACKAGE / report['archive']).resolve()
    assert archive.is_relative_to(PACKAGE / 'var'), 'archive outside package var'
    names = ['source.sqlite', 'packets.sqlite', 'signer.sqlite', 'relay.sqlite']
    if 'transactions.sqlite' in report['archiveSha256']:
        names.append('transactions.sqlite')
    for name in names:
        assert hashlib.sha256((archive / name).read_bytes()).hexdigest() == report['archiveSha256'][name], name
    sources = list(records(archive / 'source.sqlite', 'captures', 'payload'))
    packets = list(records(archive / 'packets.sqlite', 'packets', 'body'))
    deliveries = {int(r['sequence']): r for r in records(archive / 'relay.sqlite', 'deliveries', 'body')}
    samples, nonces, previous_sequence, previous_time = {}, set(), 0, 0
    for packet in sorted(packets, key=lambda p: int(p['observation']['sequence'])):
        obs = packet['observation']; sequence = int(obs['sequence'])
        delivery = deliveries.get(sequence)
        if not delivery or not delivery.get('accepted'):
            continue
        accepted = delivery['accepted']; source_ms = int(packet['sourceMs'])
        assert sequence > previous_sequence and source_ms >= previous_time
        previous_sequence, previous_time = sequence, source_ms
        assert int(obs['observedAt']) == source_ms // 1000
        assert int(obs['observedAt']) <= int(obs['publishedAt']) <= int(accepted['acceptedAt'])
        assert delivery['nonce'] not in nonces; nonces.add(delivery['nonce'])
        assert accepted['digest'] == delivery['digest'] and accepted['transactionHash'] == delivery['txHash']
        matched = False
        for source in sources:
            capture = source.get('book')
            if not capture:
                continue
            raw = json.loads(capture['body'])
            if raw.get('timestamp') != str(source_ms):
                continue
            assert raw['asset_id'] == report['config']['mapping']['outcomeTokenId']
            assert raw['market'] == report['config']['mapping']['conditionId']
            expected, valid = summary(raw, report['config'])
            if all(int(obs[k]) == v for k, v in expected.items()):
                assert accepted['depthValid'] == valid
                assert int(accepted['priceWad']) == expected['priceWad']
                matched = True; break
        assert matched, f"packet {sequence} does not match any archived authentic book"
        samples[int(obs['observedAt'])] = (int(accepted['priceWad']), accepted['depthValid'])
    assert len(nonces) == report['acceptedPackets']
    # Independent segment sum at the report's original named evaluation endpoint.
    end = int(report['twap'].get('evaluationBlock', {}).get('timestamp',
              max(int(r['accepted']['acceptedAt']) for r in deliveries.values() if r.get('accepted'))))
    ordered = sorted(samples.items()); covered, integral = 0, 0
    for i, (time, (price, valid)) in enumerate(ordered):
        if not valid:
            continue
        until = min(end, time + 30, ordered[i+1][0] if i+1 < len(ordered) else end)
        span = max(0, until - max(time, end - 300))
        covered += span; integral += span * price
    expected = {'available': covered == 300, 'coveredSecs': str(covered),
                'integral': str(integral), 'twapWad': str(integral // 300 if covered == 300 else 0)}
    assert report['twap']['actual'] == expected
    return {'report': str(path.relative_to(PACKAGE)), 'source': report['source'],
            'acceptedPackets': len(nonces), 'archiveHashesVerified': True,
            'authenticSourceTimesVerified': True, 'fractionPricesDepthVerified': True,
            'receiptBindingsAndOrderingVerified': True, 'twap': expected,
            'restart': report.get('restart'), 'productionApproved': False}


if __name__ == '__main__':
    assert len(sys.argv) >= 2, 'provide one or more pipeline report paths'
    print(json.dumps([review((PACKAGE / p).resolve()) for p in sys.argv[1:]], indent=2))
