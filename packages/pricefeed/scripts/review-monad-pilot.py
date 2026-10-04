#!/usr/bin/env python3
"""Independent offline Fraction review of the closed Monad pilot's raw books."""
import hashlib
import json
import runpy
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(PACKAGE / 'scripts/review-pipeline.py'))
report = json.loads((PACKAGE / 'artifacts/monad-testnet/publication-pilot.json').read_text())
assert report['chainId'] == 10143 and report['transactionsFinalized'] == 3
assert report['productionApproved'] is False
archive = PACKAGE / report['archive']
assert archive.resolve().is_relative_to(PACKAGE / 'var')
for name, checksum in report['archiveSha256'].items():
    assert hashlib.sha256((archive / name).read_bytes()).hexdigest() == checksum, name
sources = list(helpers['records'](archive / 'source.sqlite', 'captures', 'payload'))
assert sources == report['captures']
reviewed = []
for item in report['restartedRun']['packets']:
    packet, accepted = item['packet'], item['delivery']['accepted']
    obs = packet['observation']
    assert int(obs['observedAt']) == int(packet['sourceMs']) // 1000
    assert int(obs['observedAt']) <= int(obs['publishedAt']) <= int(accepted['acceptedAt'])
    matches = []
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
            matches.append(source)
    assert matches, f"packet {obs['sequence']} has no matching authentic raw book"
    reviewed.append({'sequence': obs['sequence'], 'sourceMs': packet['sourceMs'],
                     'priceWad': obs['priceWad'], 'depthValid': accepted['depthValid']})
output = {'verified': True, 'archiveHashesVerified': True, 'authenticSourceTimesVerified': True,
          'fractionPricesDepthVerified': True, 'packets': reviewed, 'productionApproved': False,
          'limitation': 'Three-sample pilot; sustained 300-second coverage remains to be tested.'}
(PACKAGE / 'artifacts/monad-testnet/publication-fraction-review.json').write_text(json.dumps(output, indent=2)+'\n')
print(json.dumps(output, indent=2))
