/** A failed preflight may leave a fresh publisher with no journals at all. */
export function publisherInitializationAfterFailure(initialize, present) {
  if (present.length !== 5 || present.some(value => typeof value !== 'boolean'))
    throw new Error('INVALID_PUBLISHER_JOURNAL_INVENTORY');
  if (present.every(Boolean)) return false;
  if (initialize && present.every(value => !value)) return true;
  // Never recreate a partial set, or a missing set from an existing publisher.
  throw new Error('TESTNET_JOURNAL_SET_INCOMPLETE');
}

function transientMonadReadFailure(reason) {
  return /^MONAD_(?:RPC_CHAIN|FINALIZED_BLOCK|CANONICAL_BLOCK|CODE_READ|LISTING_READ|SOURCE_READ|HALT_READ|BLOCK_READ|RECEIPT_READ|NONCE_READ|BALANCE_READ)_FAILED$/.test(reason)
    || reason === 'MONAD_STALE_OR_FUTURE_BLOCK';
}

export function transientPublisherFailure(reason) {
  return transientMonadReadFailure(reason)
    || ['MONAD_SIMULATION_FAILED', 'PIPELINE_TIMEOUT', 'RELAY_TIMEOUT', 'FINALIZED_RECEIPT_UNAVAILABLE'].includes(reason);
}

/** The service's aggregate reservation audit is authoritative, not its count of
 * accepted price packets (cancellations also consume budget). */
export function publisherBudgetExhausted(result) {
  return result.stopReason === 'publication-budget-exhausted';
}

/** Resume the same guarded recovery after transient reads fail. The recovery
 * implementation owns signatures, nonce/receipt reconciliation and all writes.
 * No new intent, cancellation scope or retry bytes are manufactured here. */
export async function recoverPublisherNonce({ recover, signal, deadline, onResult,
  now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted || now() >= deadline) return;
    let result;
    try {
      result = await recover();
    } catch (error) {
      if (!(error instanceof Error) || !(transientMonadReadFailure(error.message)
        || ['NONCE_RECOVERY_RPC_FAILED', 'NONCE_RECOVERY_RPC_TIMEOUT'].includes(error.message))
        || attempt === 2) throw error;
      await pause(2000);
      continue;
    }
    onResult(result);
    if (['FINALIZED', 'ORIGINAL_FINALIZED', 'ORIGINAL_REVERTED'].includes(result.status)) return result;
    if (attempt === 2) throw new Error('RECOVERY_STILL_PENDING');
  }
}
