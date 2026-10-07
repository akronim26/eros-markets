import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publisherInitializationAfterFailure, transientPublisherFailure } from './publisher-restart-policy.mjs';

describe('publisher startup recovery', () => {
  test('retries an initial transient preflight failure before journals exist, then resumes created journals', () => {
    let initialize = true;
    initialize = publisherInitializationAfterFailure(initialize, [false, false, false, false, false]);
    assert.equal(initialize, true);
    assert.equal(transientPublisherFailure('MONAD_FINALIZED_BLOCK_FAILED'), true);
    initialize = publisherInitializationAfterFailure(initialize, [true, true, true, true, true]);
    assert.equal(initialize, false);
    assert.throws(() => publisherInitializationAfterFailure(initialize, [false, false, false, false, false]), /TESTNET_JOURNAL_SET_INCOMPLETE/);
  });

  test('rejects every partial journal inventory for fresh and resumed publishers', () => {
    for (let mask = 1; mask < 31; mask++) {
      const present = Array.from({ length: 5 }, (_, bit) => Boolean(mask & (1 << bit)));
      for (const initialize of [true, false])
        assert.throws(() => publisherInitializationAfterFailure(initialize, present), /TESTNET_JOURNAL_SET_INCOMPLETE/);
    }
  });

  test('does not retry identity, configuration, funding or journal integrity failures', () => {
    for (const reason of ['WRONG_CHAIN', 'MONAD_CONFIG_OR_ABI_MISMATCH', 'MONAD_SENDER_NEEDS_TEST_MON',
      'TESTNET_JOURNAL_INTEGRITY', 'TESTNET_JOURNAL_SET_INCOMPLETE', 'UNCLASSIFIED_SERVICE_FAILURE'])
      assert.equal(transientPublisherFailure(reason), false);
    for (const reason of ['MONAD_CANONICAL_BLOCK_FAILED', 'MONAD_STALE_OR_FUTURE_BLOCK', 'PIPELINE_TIMEOUT', 'RELAY_TIMEOUT'])
      assert.equal(transientPublisherFailure(reason), true);
  });
});
