/** Persistent operation is explicit; it never changes transaction or funding budgets. */
export function serviceRuntime(env = process.env, defaultDuration = '5400', now = Date.now(), minimumDuration = 60) {
  const mode = env.EROS_SERVICE_MODE ?? 'bounded';
  if (!['bounded', 'persistent'].includes(mode)) throw Error('INVALID_SERVICE_MODE');
  const value = env.EROS_SERVICE_DURATION_SECONDS ?? defaultDuration;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimumDuration || Number(value) > 86400)
    throw Error('INVALID_SERVICE_DURATION');
  return { mode, durationSeconds: Number(value), end: mode === 'persistent' ? Infinity : now + Number(value) * 1000 };
}

export function liquidationPolicy(env, measuredGas) {
  const selected = env.EROS_LIQUIDATION_ENABLED;
  if (selected !== undefined && !['true', 'false'].includes(selected)) throw Error('INVALID_LIQUIDATION_ENABLED');
  const enabled = selected === 'true' || selected !== 'false' && measuredGas !== undefined;
  if (enabled && (!Number.isSafeInteger(measuredGas) || measuredGas < 21000 || measuredGas > 30_000_000))
    throw Error('MEASURED_LIQUIDATION_GAS_REQUIRED');
  const value = env.EROS_LIQUIDATION_INTERVAL_MS ?? '10000';
  if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 60000) throw Error('INVALID_LIQUIDATION_INTERVAL');
  return { enabled, intervalMs: Number(value) };
}

/** Due risk work takes one turn ahead of sampling, never another concurrent signer.
 * A pending one-time pricing activation follows rollover and precedes everything else. */
export function keeperActions({ liquidationEnabled, nextLiquidationAt, activationPending = false, now = Date.now() }) {
  const actions = ['rollover'];
  if (activationPending) actions.push('activate');
  if (liquidationEnabled && now >= nextLiquidationAt) actions.push('liquidate');
  actions.push('sample');
  return actions;
}

/** Provider wrappers retain causes; only explicit transport failures are retryable. */
export function transientServiceRead(error) {
  const codes = ['RPC_POOL_UNAVAILABLE', 'RPC_POOL_BUSY', 'RPC_POOL_BLOCK_CHANGED'];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (['HttpRequestError', 'TimeoutError', 'SocketClosedError', 'WebSocketRequestError'].includes(current.name)
      || codes.some(code => typeof current.message === 'string' && current.message.includes(code))) return true;
  }
  return false;
}
