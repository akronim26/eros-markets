import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseNativeDeployment, NATIVE_DEPLOYMENT_FIELDS } from '../src/native/manifest.js';

const sample = JSON.parse(readFileSync(new URL('../../../../artifacts/native-market/public-20261012-btc-82500/deployment.json', import.meta.url), 'utf8'));

test('public BTC deployment record parses under the strict native manifest schema', () => {
  const d = parseNativeDeployment(sample);
  assert.equal(d.chainId, 10143n);
  assert.equal(d.outcomeVault, '0x17f459C7D7164f619f851bCf174A58AD4DdAE06a');
  assert.equal(d.scheduledT, 1792018800n);
  assert.equal(NATIVE_DEPLOYMENT_FIELDS.length, 14);
});

test('native manifest rejects missing/extra fields, bad addresses/hashes and duplicate contracts', () => {
  const { yesBook: _drop, ...missing } = sample;
  assert.throws(() => parseNativeDeployment(missing), /BAD_NATIVE_DEPLOYMENT_FIELDS/);
  assert.throws(() => parseNativeDeployment({ ...sample, extra: 1 }), /BAD_NATIVE_DEPLOYMENT_FIELDS/);
  assert.throws(() => parseNativeDeployment({ ...sample, yesToken: '0x1234' }), /BAD_NATIVE_ADDRESS_yesToken/);
  assert.throws(() => parseNativeDeployment({ ...sample, marketId: '0x' + '0'.repeat(64) }), /BAD_NATIVE_HASH_marketId/);
  assert.throws(() => parseNativeDeployment({ ...sample, noBook: sample.yesBook }), /DUPLICATE_NATIVE_ADDRESS/);
  assert.throws(() => parseNativeDeployment({ ...sample, issuanceCap: 0 }), /BAD_NATIVE_DEPLOYMENT_VALUES/);
  assert.throws(() => parseNativeDeployment({ ...sample, chainId: 1.5 }), /BAD_NATIVE_INTEGER_chainId/);
});
