import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isTestnetProofDirectory} from './proof-directory.mjs';

test('public proofs accept explicit historical and repaired deployment runs', () => {
  for (const path of ['tmp/live-markets-20261006/republican-house',
    'tmp/live-markets-v4-20261007/democratic-senate',
    'tmp/redeploy-audit-20261007/nebraska-senate']) {
    assert.equal(isTestnetProofDirectory(path), true);
  }
});

test('proof custody paths reject traversal, unrelated directories and implicit runs', () => {
  for (const path of [undefined, '', '/tmp/live-markets-v4-20261007/nebraska-senate',
    'tmp/live-markets-v4-20261007/../nebraska-senate',
    'tmp/live-markets-v4-20261007/nebraska-senate/../../',
    'tmp/redeploy-audit-20261007/nebraska-senate/other',
    'tmp/redeploy-audit-latest/nebraska-senate', 'tmp/unrelated-20261007/nebraska-senate']) {
    assert.equal(isTestnetProofDirectory(path), false);
  }
});
