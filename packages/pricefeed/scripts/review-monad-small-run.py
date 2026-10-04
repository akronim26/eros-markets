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
for nonce, (item, receipt) in enumerate(zip(report['packets'], report['receipts'], strict=True)):
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
          'newReservationsWei': str(new_reserved), 'packets': reviewed, 'twap': expected,
          'productionApproved': False, 'limitation': 'Bounded gas test; sustained coverage remains separate.'}
(PACKAGE / 'artifacts/monad-testnet/optimized-small-run-review.json').write_text(json.dumps(output, indent=2)+'\n')
print(json.dumps(output, indent=2))
