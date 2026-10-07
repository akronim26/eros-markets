import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publisherInitializationAfterFailure, transientPublisherFailure, recoverPublisherNonce } from './publisher-restart-policy.mjs';

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
    for (const reason of ['MONAD_CANONICAL_BLOCK_FAILED', 'MONAD_STALE_OR_FUTURE_BLOCK', 'MONAD_SIMULATION_FAILED', 'PIPELINE_TIMEOUT', 'RELAY_TIMEOUT'])
      assert.equal(transientPublisherFailure(reason), true);
  });
});

test('recovery retries transient read errors and reconciles uncertainty through the same recovery callback', async () => {
  let calls = 0;
  const results = [], pauses = [], signal = new AbortController().signal;
  const receipt = { status: 'FINALIZED', hash: 'same-cancellation-hash' };
  const result = await recoverPublisherNonce({ signal, deadline: 100, now: () => 0,
    pause: async ms => { pauses.push(ms); }, onResult: value => results.push(value),
    recover: async () => {
      calls++;
      if (calls === 1) throw new Error('NONCE_RECOVERY_RPC_FAILED');
      return calls === 2 ? { status: 'UNKNOWN', hash: receipt.hash } : receipt;
    } });
  assert.equal(calls, 3); assert.deepEqual(pauses, [2000]);
  assert.equal(result, receipt); assert.deepEqual(results, [{ status: 'UNKNOWN', hash: receipt.hash }, receipt]);
});

test('recovery preserves fatal errors and caps RPC failure retries without new intent', async () => {
  for (const reason of ['NONCE_RECOVERY_RPC_TIMEOUT', 'MONAD_RPC_CHAIN_FAILED', 'MONAD_CANONICAL_BLOCK_FAILED',
    'MONAD_STALE_OR_FUTURE_BLOCK', 'NONCE_RECOVERY_CANONICAL_MISMATCH', 'NONCE_RECOVERY_ORIGINAL_INCLUDED',
    'MONAD_WRONG_CHAIN', 'MONAD_SIMULATION_FAILED', 'TESTNET_RELAY_BUDGET_EXHAUSTED']) {
    let calls = 0;
    const error = new Error(reason);
    await assert.rejects(recoverPublisherNonce({ signal: new AbortController().signal, deadline: 100, now: () => 0,
      pause: async () => {}, onResult: () => assert.fail('No successful result expected'),
      recover: async () => { calls++; throw error; } }), actual => actual === error);
    assert.equal(calls, ['NONCE_RECOVERY_RPC_TIMEOUT', 'MONAD_RPC_CHAIN_FAILED', 'MONAD_CANONICAL_BLOCK_FAILED',
      'MONAD_STALE_OR_FUTURE_BLOCK'].includes(reason) ? 3 : 1);
  }
});

test('recovery does not start another attempt after shutdown or campaign deadline', async () => {
  for (const abort of [true, false]) {
    const controller = new AbortController(); let calls = 0, time = 0;
    await recoverPublisherNonce({ signal: controller.signal, deadline: 100, now: () => time,
      pause: async () => { if (abort) controller.abort(); else time = 100; }, onResult: () => assert.fail('No success expected'),
      recover: async () => { calls++; throw new Error('NONCE_RECOVERY_RPC_FAILED'); } });
    assert.equal(calls, 1);
  }
});
