#!/usr/bin/env python3
"""Independent offline source/Fraction, integer gas and capacity review."""
import hashlib
import json
import runpy
import sqlite3
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
root = PACKAGE / 'artifacts/monad-testnet'
q = json.loads((root / 'gas-quote.json').read_text())
cost = json.loads((root / 'cost-capacity.json').read_text())
config = json.loads((root / 'market-config.json').read_text())
helpers = runpy.run_path(str(PACKAGE / 'scripts/review-pipeline.py'))
assert q['chainId'] == 10143 and q['transactionsSent'] == q['transactionNoncesReserved'] == 0
assert q['nonceBefore'] == q['nonceAfter'] == '3' and q['quotePacketExpired']
obs, book = q['packet']['observation'], json.loads(q['sourceCapture']['book']['body'])
assert book['asset_id'] == config['mapping']['outcomeTokenId']
assert book['market'] == config['mapping']['conditionId']
assert book['timestamp'] == q['packet']['sourceMs']
assert int(obs['observedAt']) == int(book['timestamp']) // 1000
expected, valid = helpers['summary'](book, config)
assert valid and all(int(obs[k]) == v for k, v in expected.items())
assert int(obs['observedAt']) <= int(obs['publishedAt']) <= int(q['quoteFinishedAtMs']) // 1000
assert int(q['quoteFinishedAtMs']) - int(book['timestamp']) < 25000
estimate, margin = int(q['sizing']['estimatedGas']), int(q['sizing']['marginBps'])
limit = (estimate * (10000 + margin) + 9999) // 10000
assert limit == int(q['sizing']['gasLimit']) <= 800000
assert int(q['maxCostWei']) == limit * int(cost['maxFeePerGasWei'])
assert cost['quoteSha256'] == hashlib.sha256((root / 'gas-quote.json').read_bytes()).hexdigest()
for case in cost['daily']:
    for name, price, gas in [('atPilotPrice', int(cost['historicalPaidGasPriceWei']), limit),
                             ('atMaxFee', int(cost['maxFeePerGasWei']), limit),
                             ('oldLimitAtPilotPrice', int(cost['historicalPaidGasPriceWei']), 800000)]:
        row = case[name]
        count = row['markets'] * ((row['durationSeconds'] + row['intervalSeconds'] - 1) // row['intervalSeconds'])
        assert int(row['submissions']) == count
        assert int(row['costPerSubmissionWei']) == gas * price
        assert int(row['totalCostWei']) == gas * price * count
campaign = cost['proposedCampaign']
assert int(campaign['nominalSubmissions']) == 72
assert int(campaign['estimatedCostAtPilotPriceWei']) == limit * int(cost['historicalPaidGasPriceWei']) * 72
assert int(campaign['estimatedReservationAtQuoteLimitWei']) == limit * int(cost['maxFeePerGasWei']) * 72
assert int(campaign['proposedPolicy']['budget']['totalMaxCostWei']) == int(campaign['existingReservedWei']) + int(campaign['additionalReservationWei'])
assert int(campaign['fundingGapWei']) == max(0, int(campaign['additionalReservationWei']) - int(campaign['observedBalanceWei']))
assert not campaign['activated'] and not cost['productionApproved'] and not cost['cadenceApproved']
archive = PACKAGE / 'var/monad-testnet/pilot'
pilot = json.loads((root / 'publication-pilot.json').read_text())
for name in ['relay.sqlite', 'transactions.sqlite']:
    assert hashlib.sha256((archive / name).read_bytes()).hexdigest() == pilot['archiveSha256'][name]
packets = sqlite3.connect(f'file:{archive / "packets.sqlite"}?mode=ro', uri=True)
row = packets.execute('SELECT body,sha256,digest,signature,state,reason FROM packets WHERE sequence=?', (q['sequence'],)).fetchone()
assert row and hashlib.sha256(row[0].encode()).hexdigest() == row[1]
assert json.loads(row[0]) == q['packet'] and row[2] == q['digest'] and row[3] == q['signature']
assert row[4:] == ('EXPIRED', 'GAS_QUOTE_ONLY_NOT_FOR_DELIVERY')
packets.close()
relay = sqlite3.connect(f'file:{archive / "relay.sqlite"}?mode=ro', uri=True)
assert relay.execute('SELECT count(*) FROM deliveries').fetchone()[0] == 3
assert relay.execute('SELECT next_nonce FROM relay_nonce').fetchone()[0] == q['nonceAfter']
assert q['checkpoint']['engine']['sourceState']['lastSequence'] == '3'
relay.close()
output = {'verified': True, 'fractionPricesDepthVerified': True, 'authenticSourceTimeVerified': True,
          'integerGasMarginAndCostsVerified': True, 'quotePacketDurablyExpired': True,
          'relayAndTransactionJournalsUnchanged': True,
          'transactionsSent': 0, 'existingDeliveryCount': 3, 'productionApproved': False,
          'limitation': 'RPC simulation estimate, not an optimized paid receipt or sustained coverage proof.'}
(root / 'gas-quote-review.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output, indent=2))
