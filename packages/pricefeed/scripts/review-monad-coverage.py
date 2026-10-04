#!/usr/bin/env python3
"""Offline independent Fraction/source, budget and historical-block coverage review."""
import hashlib
import json
import runpy
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(PACKAGE / 'scripts/review-pipeline.py'))


def replay(items, receipts, block):
    samples = {}
    for item, receipt in zip(items, receipts, strict=True):
        if int(receipt['accepted']['blockNumber']) > int(block['number']):
            continue
        obs, accepted = item['packet']['observation'], receipt['accepted']
        assert int(obs['observedAt']) <= int(accepted['acceptedAt']) <= int(block['timestamp'])
        samples[int(obs['observedAt'])] = (int(accepted['priceWad']), accepted['depthValid'])
    end, covered, integral = int(block['timestamp']), 0, 0
    ordered = sorted(samples.items())
    for i, (time, (price, valid)) in enumerate(ordered):
        if not valid:
            continue
        until = min(end, time + 30, ordered[i+1][0] if i+1 < len(ordered) else end)
        span = max(0, until - max(time, end - 300))
        covered += span
        integral += span * price
    return {'available': covered == 300, 'coveredSecs': str(covered), 'integral': str(integral),
            'twapWad': str(integral // 300 if covered == 300 else 0)}


def review(report, baseline, plan):
    assert report['mode'] == 'MONAD_TESTNET_SUSTAINED_COVERAGE_DIAGNOSTIC'
    assert report['chainId'] == 10143 and report['productionApproved'] is False
    assert report['approvedPlanHash'] == plan['approvalHash']
    archive = (PACKAGE / report['archive']).resolve()
    assert archive.is_relative_to(PACKAGE / 'var')
    assert set(report['archiveSha256']) == {'source.sqlite', 'packets.sqlite', 'signer.sqlite', 'transactions.sqlite', 'relay.sqlite'}
    for name, checksum in report['archiveSha256'].items():
        assert hashlib.sha256((archive / name).read_bytes()).hexdigest() == checksum
    sources = list(helpers['records'](archive / 'source.sqlite', 'captures', 'payload'))
    assert sources == report['captures']
    assert sources[:len(baseline['captures'])] == baseline['captures']
    archived_packets = {p['observation']['sequence']: p for p in
                        helpers['records'](archive / 'packets.sqlite', 'packets', 'body')}
    deliveries = sorted(helpers['records'](archive / 'relay.sqlite', 'deliveries', 'body'), key=lambda r: int(r['nonce']))
    recoveries = list(helpers['records'](archive / 'relay.sqlite', 'nonce_recoveries', 'body'))
    assert deliveries == report['deliveries']
    assert sorted(recoveries, key=lambda r: r['key']) == sorted(report['recoveries'], key=lambda r: r['key'])
    assert deliveries[:len(baseline['deliveries'])] == baseline['deliveries']
    assert report['packets'][:len(baseline['packets'])] == baseline['packets']
    assert len(report['packets']) == len(report['receipts']) == report['transactionsFinalized']
    assert len(report['packets']) == sum(d['state'] == 'FINALIZED' for d in deliveries)
    assert report['optimizedTransactionsFinalized'] == len(report['packets']) - baseline['transactionsFinalized']
    assert len(deliveries) + len(recoveries) <= report['policy']['budget']['maxTransactions']
    assert len(deliveries) + len(recoveries) - plan['deliveryCount'] <= plan['additionalTransactionSlots']
    assert [int(r['nonce']) for r in deliveries] == list(range(len(deliveries)))
    old_nonces = {r['nonce'] for r in baseline['deliveries']}
    old_recoveries = {r['key'] for r in baseline['recoveries']}
    total_cost, new_cost, new_reserved, reserved = 0, 0, 0, 0
    previous_sequence, previous_time = 0, 0
    for item, receipt in zip(report['packets'], report['receipts'], strict=True):
        packet, delivery = item['packet'], item['delivery']
        obs, accepted = packet['observation'], receipt['accepted']
        assert packet == archived_packets[obs['sequence']]
        assert delivery == deliveries[int(delivery['nonce'])] and delivery['state'] == 'FINALIZED'
        assert receipt['nonce'] == int(delivery['nonce']) and receipt['sequence'] == obs['sequence']
        assert delivery['accepted'] == accepted and item['digest'] == accepted['digest']
        assert delivery['txHash'] == accepted['transactionHash'] == receipt['receipt']['transactionHash']
        assert accepted['blockNumber'] == receipt['receipt']['blockNumber']
        assert accepted['blockHash'] == receipt['receipt']['blockHash']
        assert int(obs['sequence']) > previous_sequence and int(packet['sourceMs']) >= previous_time
        previous_sequence, previous_time = int(obs['sequence']), int(packet['sourceMs'])
        assert int(obs['observedAt']) == previous_time // 1000
        assert int(obs['observedAt']) <= int(obs['publishedAt']) <= int(accepted['acceptedAt'])
        matched = False
        for source in sources:
            if not source.get('book'):
                continue
            raw = json.loads(source['book']['body'])
            if raw.get('timestamp') != packet['sourceMs']:
                continue
            assert raw['asset_id'] == report['config']['mapping']['outcomeTokenId']
            assert raw['market'] == report['config']['mapping']['conditionId']
            expected, valid = helpers['summary'](raw, report['config'])
            if all(int(obs[k]) == value for k, value in expected.items()):
                assert accepted['depthValid'] == valid and int(accepted['priceWad']) == expected['priceWad']
                matched = True
                break
        assert matched, f"sequence {obs['sequence']} lacks matching authentic source book"
        cost = int(receipt['gasUsed']) * int(receipt['effectiveGasPrice'])
        reservation = int(delivery['request']['gas']) * int(delivery['request']['maxFeePerGas'])
        assert receipt['gasLimit'] == delivery['request']['gas']
        assert 0 < int(receipt['gasUsed']) <= int(receipt['gasLimit'])
        assert cost == int(receipt['gasCostWei']) <= reservation == int(receipt['reservationWei'])
        total_cost += cost
        if delivery['nonce'] not in old_nonces:
            new_cost += cost
    for delivery in deliveries:
        request = delivery['request']
        reservation = int(request['gas']) * int(request['maxFeePerGas'])
        assert reservation <= int(report['policy']['relay']['maxCostWei'])
        assert int(request['gas']) <= int(report['policy']['relay']['gasCap'])
        assert int(request['maxFeePerGas']) <= int(report['policy']['relay']['maxFeePerGas'])
        assert int(request['maxPriorityFeePerGas']) <= int(report['policy']['relay']['maxPriorityFeePerGas'])
        reserved += reservation
        if delivery['nonce'] not in old_nonces:
            sizing = delivery['gasSizing']
            assert int(sizing['marginBps']) == int(report['policy']['relay']['gasSafetyMarginBps'])
            expected_gas = (int(sizing['estimatedGas']) * (10000 + int(sizing['marginBps'])) + 9999) // 10000
            assert expected_gas == int(request['gas']) == int(sizing['gasLimit'])
            new_reserved += reservation
    for recovery, receipt in zip(report['recoveries'], report['recoveryReceipts'], strict=True):
        assert recovery['state'] == 'FINALIZED' and recovery['receipt'] == receipt['receipt']
        original = json.loads(recovery['originalBody'])
        assert hashlib.sha256(recovery['originalBody'].encode()).hexdigest() == recovery['originalSha256']
        assert original['attempts'] == 0
        assert deliveries[int(recovery['nonce'])] == {**original, 'state': 'CANCELLED', 'reason': 'NONCE_CANCELLED'}
        assert recovery['request']['gas'] == '21000' and recovery['receipt']['status'] == 'success'
        assert recovery['receipt']['transactionHash'] == recovery['hash'] and not recovery['receipt']['logs']
        reservation = 21000 * int(recovery['request']['maxFeePerGas'])
        cost = int(receipt['gasUsed']) * int(receipt['effectiveGasPrice'])
        assert cost == int(receipt['gasCostWei']) <= reservation == int(recovery['reservationWei'])
        reserved += reservation
        total_cost += cost
        if recovery['key'] not in old_recoveries:
            new_reserved += reservation
            new_cost += cost
    assert new_reserved == int(report['newReservationsWei']) <= int(plan['remainingReservationWei'])
    assert reserved - new_reserved == int(plan['reservedWei'])
    assert reserved <= int(report['policy']['budget']['totalMaxCostWei'])
    assert total_cost == int(report['totalGasCostWei']) and new_cost == int(report['newGasCostWei']) <= new_reserved
    checks = report['checks']
    assert [c['phase'] for c in checks] == ['initial', 'gap', 'recovered']
    for c in [*checks, *report['candidateWindows']]:
        assert c['actual'] == replay(report['packets'], report['receipts'], c['block'])
    for c in checks:
        known = [(i, r) for i, r in zip(report['packets'], report['receipts'], strict=True)
                 if int(r['accepted']['blockNumber']) <= int(c['block']['number'])]
        obs = known[-1][0]['packet']['observation']
        assert c['sourceState']['lastSequence'] == obs['sequence']
        assert c['sourceState']['lastObservedAt'] == obs['observedAt']
    initial, gap, recovered = checks
    for left, right in zip(checks, checks[1:]):
        assert int(left['block']['number']) < int(right['block']['number'])
        assert int(left['block']['timestamp']) < int(right['block']['timestamp'])
    assert initial['actual']['available'] and recovered['actual']['available']
    assert not gap['actual']['available'] and int(gap['actual']['coveredSecs']) < 300
    assert gap['sourceState'] == initial['sourceState']
    last = next(r for r in report['receipts'] if r['sequence'] == initial['sourceState']['lastSequence'])
    assert int(gap['block']['timestamp']) > int(last['accepted']['acceptedAt']) + 30
    fresh = next(i for i, r in zip(report['packets'], report['receipts'], strict=True)
                 if int(r['accepted']['blockNumber']) > int(gap['block']['number']))
    assert int(fresh['packet']['observation']['observedAt']) >= int(gap['block']['timestamp'])
    assert int(recovered['block']['timestamp']) - 300 >= int(fresh['packet']['observation']['observedAt'])
    assert report['acceptance']['verified'] is True
    return {'verified': True, 'authenticSourceFractionReview': True, 'historicalBlockReplay': True,
            'oldSignedHistoryUnchanged': True, 'newGasCostWei': str(new_cost), 'newReservationsWei': str(new_reserved),
            'phases': [{'phase': c['phase'], 'block': c['block'], 'twap': c['actual']} for c in checks],
            'productionApproved': False}


if __name__ == '__main__':
    root = PACKAGE / 'artifacts/monad-testnet'
    report = json.loads((root / 'coverage-run.json').read_text())
    baseline_bytes = (root / 'optimized-small-run.json').read_bytes()
    assert hashlib.sha256(baseline_bytes).hexdigest() == report['baselineEvidenceSha256']
    result = review(report, json.loads(baseline_bytes), json.loads((root / 'coverage-budget-plan.json').read_text()))
    (root / 'coverage-run-review.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
