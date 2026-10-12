/**
 * Wake-on-visit for one market's workers. Workers sleep only when nobody has visited for the idle
 * timeout AND no account is leveraged; every failed read keeps (or makes) the market awake.
 * Sleeping costs nothing and wakes resume the same journals. Read-only: no signing, no funding.
 */
export const ACTIVITY_POLL_MS = 15_000;
export const IDLE_MS = 600_000;

export function wakeConfig(input) {
  if (input === undefined) return null; // no activity source configured: always awake
  const url = new URL(input.url);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('ACTIVITY_URL_HTTPS_REQUIRED');
  if (url.username || url.password) throw Error('ACTIVITY_URL_CREDENTIALS_FORBIDDEN');
  const int = (name, fallback, low, high) => {
    const v = input[name] ?? fallback;
    if (!Number.isInteger(v) || v < low || v > high) throw Error(`INVALID_WAKE_${name.toUpperCase()}`);
    return v;
  };
  return { url: url.href, pollMs: int('pollMs', ACTIVITY_POLL_MS, 5_000, 120_000), idleMs: int('idleMs', IDLE_MS, 60_000, 86_400_000) };
}

/**
 * Decide the next transition. `lastSeenMs`: newest visitor heartbeat for this engine, `null`
 * when none is recorded, `undefined` when the activity read failed. `leveraged`: true/false, or
 * `undefined` when the on-chain read failed (only consulted before sleeping).
 */
export function wakeDecision({ state, nowMs, lastSeenMs, leveraged, idleMs }) {
  const readFailed = lastSeenMs === undefined;
  const visited = !readFailed && lastSeenMs !== null && nowMs - lastSeenMs < idleMs;
  if (state === 'asleep') return readFailed || visited ? { action: 'wake', reason: readFailed ? 'activity-read-failed' : 'visitor' } : { action: 'stay' };
  if (state === 'sleeping') return { action: 'stay' }; // wait for the clean stop, then decide again
  if (state !== 'awake') throw Error('UNKNOWN_WAKE_STATE');
  if (readFailed || visited) return { action: 'stay' };
  if (leveraged === undefined) return { action: 'stay', reason: 'leverage-read-failed' };
  if (leveraged) return { action: 'stay', reason: 'leveraged-account' };
  return { action: 'sleep', reason: lastSeenMs === null ? 'no-visitor' : 'idle' };
}

/** Only the leverage guard needs to run before a sleep; reading it on every poll wastes RPC. */
export const needsLeverageRead = ({ state, nowMs, lastSeenMs, idleMs }) =>
  state === 'awake' && lastSeenMs !== undefined && (lastSeenMs === null || nowMs - lastSeenMs >= idleMs);

/** Parse `GET /api/market-activity`: `{ engines: { <engine lower-case>: <last seen ms> } }`. */
export function lastSeenFor(body, engine, nowMs) {
  const value = body?.engines?.[engine.toLowerCase()];
  if (value === undefined || value === null) return null;
  // A future heartbeat is clock skew or forgery; it never extends the awake time.
  if (!Number.isSafeInteger(value) || value < 0) throw Error('INVALID_ACTIVITY_RESPONSE');
  return Math.min(value, nowMs);
}

export async function readActivity({ fetchImpl = fetch, url, engines, nowMs, timeoutMs = 5_000 }) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Error('ACTIVITY_READ_FAILED');
  const body = await response.json();
  return Object.fromEntries(engines.map(engine => [engine.toLowerCase(), lastSeenFor(body, engine, nowMs)]));
}

/** Any account with negative E0 or E1 is leveraged (backed by margin, not full collateral). */
export async function anyLeveraged({ client, engine, abi, blockNumber, maxParticipants = 4096 }) {
  const count = await client.readContract({ address: engine, abi, functionName: 'participantCount', blockNumber });
  if (count > BigInt(maxParticipants)) throw Error('LEVERAGE_SCAN_LIMIT');
  for (let i = 0n; i < count; ++i) {
    const [id] = await client.readContract({ address: engine, abi, functionName: 'traderIdAt', args: [i], blockNumber });
    const view = await client.readContract({ address: engine, abi, functionName: 'previewAccount', args: [id], blockNumber });
    if (view.e0Q < 0n || view.e1Q < 0n) return true;
  }
  return false;
}
