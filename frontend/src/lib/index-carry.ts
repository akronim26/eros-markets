/**
 * Seconds an authenticated INDEX observation stays valid on Monad testnet (chain 10143). The
 * publisher sends about every 80 s; the engine's `pricingWindows()` reports the same carry.
 */
export const INDEX_CARRY_SECS = 120;
