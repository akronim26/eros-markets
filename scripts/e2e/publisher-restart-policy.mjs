/** A failed preflight may leave a fresh publisher with no journals at all. */
export function publisherInitializationAfterFailure(initialize, present) {
  if (present.length !== 5 || present.some(value => typeof value !== 'boolean'))
    throw new Error('INVALID_PUBLISHER_JOURNAL_INVENTORY');
  if (present.every(Boolean)) return false;
  if (initialize && present.every(value => !value)) return true;
  // Never recreate a partial set, or a missing set from an existing publisher.
  throw new Error('TESTNET_JOURNAL_SET_INCOMPLETE');
}

export function transientPublisherFailure(reason) {
  return /^MONAD_(?:RPC_CHAIN|FINALIZED_BLOCK|CANONICAL_BLOCK|CODE_READ|LISTING_READ|SOURCE_READ|HALT_READ|BLOCK_READ|RECEIPT_READ|NONCE_READ|BALANCE_READ)_FAILED$/.test(reason)
    || ['MONAD_STALE_OR_FUTURE_BLOCK', 'PIPELINE_TIMEOUT', 'RELAY_TIMEOUT'].includes(reason);
}
