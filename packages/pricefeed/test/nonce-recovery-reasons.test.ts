import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverableUnsentReason } from '../src/nonce-recovery-journal.js';

test('an unsent delivery quarantined by a pipeline timeout is recoverable; unknown reasons are not', () => {
  for (const reason of ['RELAY_HEADROOM_EXPIRED', 'RESERVED_NONCE_HEADROOM_EXPIRED', 'PIPELINE_TIMEOUT',
    'LIFECYCLE_BLOCKED:SOURCE_UNAVAILABLE:LIFECYCLE_RPC_UNAVAILABLE']) assert.equal(recoverableUnsentReason(reason), true, reason);
  for (const reason of ['RELAY_JOURNAL_INTEGRITY', 'PIPELINE_TIMEOUT_EXTRA', null, undefined, 'NONCE_CANCELLED'])
    assert.equal(recoverableUnsentReason(reason), false, String(reason));
});
