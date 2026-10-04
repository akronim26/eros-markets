#!/usr/bin/env python3
"""Independent raw-book Fraction, cost and 300-second segment review."""
import hashlib
import json
import runpy
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(PACKAGE / 'scripts/review-pipeline.py'))
report = json.loads((PACKAGE / 'artifacts/monad-testnet/optimized-small-run.json').read_text())
pilot = json.loads((PACKAGE / 'artifacts/monad-testnet/publication-pilot.json').read_text())
plan = json.loads((PACKAGE / 'artifacts/monad-testnet/small-run-budget-plan.json').read_text())
assert report['chainId'] == 10143 and report['productionApproved'] is False
assert 1 <= report['optimizedTransactionsFinalized'] <= 8
assert report['approvedPlanHash'] == plan['approvalHash']
archive = (PACKAGE / report['archive']).resolve()
assert archive.is_relative_to(PACKAGE / 'var')
for name, checksum in report['archiveSha256'].items():
    assert hashlib.sha256((archive / name).read_bytes()).hexdigest() == checksum
sources = list(helpers['records'](archive / 'source.sqlite', 'captures', 'payload'))
assert sources == report['captures']
assert report['packets'][:3] == pilot['restartedRun']['packets']
samples, reviewed, total_cost, new_cost, new_reserved = {}, [], 0, 0, 0
previous_sequence, previous_time = 0, 0
for price_index, (item, receipt) in enumerate(zip(report['packets'], report['receipts'], strict=True)):
    nonce = receipt['nonce']
    assert nonce == price_index + (1 if price_index >= 3 else 0)
    packet, delivery = item['packet'], item['delivery']
    obs, accepted = packet['observation'], receipt['accepted']
    assert delivery['accepted'] == accepted and delivery['state'] == 'FINALIZED'
    assert receipt['nonce'] == nonce == int(delivery['nonce'])
    assert receipt['sequence'] == obs['sequence']
    assert int(obs['sequence']) > previous_sequence and int(packet['sourceMs']) >= previous_time
    previous_sequence, previous_time = int(obs['sequence']), int(packet['sourceMs'])
    assert int(obs['observedAt']) == int(packet['sourceMs']) // 1000
    assert int(obs['observedAt']) <= int(obs['publishedAt']) <= int(accepted['acceptedAt'])
    assert accepted['transactionHash'] == delivery['txHash'] and accepted['digest'] == item['digest']
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
            assert accepted['depthValid'] == valid
            assert int(accepted['priceWad']) == expected['priceWad']
            matched = True
            break
    assert matched, f"observation {obs['sequence']} has no authentic matching raw book"
    cost = int(receipt['gasUsed']) * int(receipt['effectiveGasPrice'])
    reservation = int(delivery['request']['gas']) * int(delivery['request']['maxFeePerGas'])
    assert cost == int(receipt['gasCostWei']) <= reservation == int(receipt['reservationWei'])
    total_cost += cost
    if nonce >= 3:
        sizing = delivery['gasSizing']
        estimate, margin = int(sizing['estimatedGas']), int(sizing['marginBps'])
        assert margin == 1000
        assert (estimate * (10000 + margin) + 9999) // 10000 == int(receipt['gasLimit']) == int(sizing['gasLimit'])
        new_cost += cost
        new_reserved += reservation
    samples[int(obs['observedAt'])] = (int(obs['priceWad']), accepted['depthValid'])
    reviewed.append({'sequence': obs['sequence'], 'nonce': nonce, 'gasCostWei': str(cost),
                     'depthValid': accepted['depthValid']})
assert len(reviewed) == report['transactionsFinalized'] == report['optimizedTransactionsFinalized'] + 3
assert len(report['recoveries']) == len(report['recoveryReceipts']) == 1
recovery, cancel_receipt = report['recoveries'][0], report['recoveryReceipts'][0]
assert recovery['state'] == 'FINALIZED' and recovery['nonce'] == '3'
assert recovery['sender'].lower() == report['sender'].lower() and recovery['request']['gas'] == '21000'
assert recovery['receipt'] == cancel_receipt['receipt'] and recovery['receipt']['status'] == 'success'
assert recovery['receipt']['transactionHash'] == recovery['hash'] and not recovery['receipt']['logs']
assert list(helpers['records'](archive / 'relay.sqlite', 'nonce_recoveries', 'body')) == report['recoveries']
original = json.loads(recovery['originalBody'])
assert hashlib.sha256(recovery['originalBody'].encode()).hexdigest() == recovery['originalSha256']
stopped = json.loads((PACKAGE / 'artifacts/monad-testnet/stopped-small-run.json').read_text())
assert original == stopped['reservedDelivery'] and original['attempts'] == 0
cancelled = [r for r in report['deliveries'] if r['state'] == 'CANCELLED']
assert len(cancelled) == 1 and cancelled[0] == {**original, 'state': 'CANCELLED', 'reason': 'NONCE_CANCELLED'}
assert len(report['deliveries']) + len(report['recoveries']) <= report['policy']['budget']['maxTransactions']
cancel_cost = int(cancel_receipt['gasUsed']) * int(cancel_receipt['effectiveGasPrice'])
assert cancel_cost == int(cancel_receipt['gasCostWei']) == int(report['recoveryGasCostWei'])
cancel_reservation = 21000 * int(recovery['request']['maxFeePerGas'])
assert cancel_cost <= cancel_reservation == int(recovery['reservationWei'])
new_reserved += cancel_reservation + int(original['request']['gas']) * int(original['request']['maxFeePerGas'])
total_cost += cancel_cost
assert new_cost + cancel_cost == int(report['newGasCostWei']) <= int(plan['additionalReservationWei'])
assert total_cost == int(report['totalGasCostWei']) and new_cost == int(report['optimizedGasCostWei'])
assert new_reserved == int(report['newReservationsWei']) <= int(plan['additionalReservationWei'])
end = int(report['twap']['evaluationBlock']['timestamp'])
ordered, covered, integral = sorted(samples.items()), 0, 0
for i, (time, (price, valid)) in enumerate(ordered):
    if not valid:
        continue
    until = min(end, time + 30, ordered[i+1][0] if i+1 < len(ordered) else end)
    span = max(0, until - max(time, end - 300))
    covered += span
    integral += span * price
expected = {'available': covered == 300, 'coveredSecs': str(covered), 'integral': str(integral),
            'twapWad': str(integral // 300 if covered == 300 else 0)}
assert report['twap']['actual'] == expected
output = {'verified': True, 'archiveHashesVerified': True, 'authenticSourceFractionReview': True,
          'oldSignedHistoryUnchanged': True, 'optimizedGasCostWei': str(new_cost),
          'recoveryGasCostWei': str(cancel_cost), 'newGasCostWei': str(new_cost + cancel_cost),
          'newReservationsWei': str(new_reserved), 'packets': reviewed, 'twap': expected,
          'productionApproved': False, 'limitation': 'Bounded gas test; sustained coverage remains separate.'}
(PACKAGE / 'artifacts/monad-testnet/optimized-small-run-review.json').write_text(json.dumps(output, indent=2)+'\n')
print(json.dumps(output, indent=2))
