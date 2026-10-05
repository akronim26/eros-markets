import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const LIVE_CLOCK_POLICY = { samples: 3, maximumRttMs: 1000, maximumOffsetMs: 1500,
  maximumBlockAgeMs: 5000, maximumBlockFutureMs: 1000, maximumWallJumpMs: 100 } as const;
export type ClockCapture = { url: string; startedAtMs: number; receivedAtMs: number; rttMs: number;
  status: number; body: string; bodySha256: string };
type Bounds = { earliestOffsetMs: number; latestOffsetMs: number };
export function liveClockBounds(capture: ClockCapture, seconds: number): Bounds {
  if (!Number.isSafeInteger(seconds) || seconds < 1514764800 || seconds >= 4102444800)
    throw new Error('LIVE_CLOCK_SECONDS_REQUIRED');
  if (!Number.isSafeInteger(capture.startedAtMs) || !Number.isSafeInteger(capture.receivedAtMs)
    || !Number.isFinite(capture.rttMs) || capture.rttMs < 0 || capture.receivedAtMs < capture.startedAtMs)
    throw new Error('LIVE_CLOCK_INVALID_TIMING');
  if (capture.rttMs > LIVE_CLOCK_POLICY.maximumRttMs) throw new Error('LIVE_CLOCK_RTT_TOO_HIGH');
  if (Math.abs(capture.receivedAtMs - capture.startedAtMs - capture.rttMs) > LIVE_CLOCK_POLICY.maximumWallJumpMs)
    throw new Error('LIVE_CLOCK_WALL_JUMP');
  // The server's integer second was sampled somewhere inside the entire request.
  // Include both transport directions and its one-second quantization uncertainty.
  return { earliestOffsetMs: seconds * 1000 - capture.receivedAtMs,
    latestOffsetMs: (seconds + 1) * 1000 - capture.startedAtMs };
}
export function validateLiveTimeCapture(capture: ClockCapture): Bounds {
  if (capture.status !== 200) throw new Error('LIVE_CLOCK_HTTP_FAILED');
  const seconds: unknown = JSON.parse(capture.body);
  if (typeof seconds !== 'number') throw new Error('LIVE_CLOCK_SECONDS_REQUIRED');
  const bounds = liveClockBounds(capture, seconds);
  if (bounds.earliestOffsetMs < -LIVE_CLOCK_POLICY.maximumOffsetMs || bounds.latestOffsetMs > LIVE_CLOCK_POLICY.maximumOffsetMs)
    throw new Error('LIVE_CLOCK_HOST_SKEW');
  return bounds;
}
function rpcResult(capture: ClockCapture): unknown {
  if (capture.status !== 200) throw new Error('LIVE_CLOCK_HTTP_FAILED');
  const value = JSON.parse(capture.body) as Record<string, unknown>;
  if (value.jsonrpc !== '2.0' || value.id !== 1 || value.error || value.result === undefined)
    throw new Error('LIVE_CLOCK_RPC_FAILED');
  return value.result;
}
export function validateLiveMonadChain(capture: ClockCapture): void {
  if (rpcResult(capture) !== '0x279f') throw new Error('LIVE_CLOCK_MONAD_CHAIN_REQUIRED');
}
export function validateLiveMonadCapture(capture: ClockCapture): Bounds & { blockHash: string; blockNumber: string } {
  const block = rpcResult(capture) as Record<string, unknown> | null;
  if (!block || typeof block.timestamp !== 'string' || !/^0x[1-9a-f][0-9a-f]*$/i.test(block.timestamp)
    || typeof block.number !== 'string' || !/^0x[1-9a-f][0-9a-f]*$/i.test(block.number)
    || typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error('LIVE_CLOCK_MONAD_BLOCK_INVALID');
  const quantized = liveClockBounds(capture, Number(BigInt(block.timestamp)));
  // A block's protocol timestamp is the exact recorded integer, not a truncated
  // sample of the remote wallclock. Only request placement is uncertain here.
  const bounds = { ...quantized, latestOffsetMs: quantized.latestOffsetMs - 1000 };
  if (bounds.earliestOffsetMs < -LIVE_CLOCK_POLICY.maximumBlockAgeMs || bounds.latestOffsetMs > LIVE_CLOCK_POLICY.maximumBlockFutureMs)
    throw new Error('LIVE_CLOCK_MONAD_BLOCK_STALE_OR_FUTURE');
  return { ...bounds, blockHash: block.hash, blockNumber: BigInt(block.number).toString() };
}

type Request = (url: string, init?: RequestInit) => Promise<ClockCapture>;
async function captureClock(url: string, init: RequestInit = {}): Promise<ClockCapture> {
  const startedAtMs = Date.now(), began = performance.now();
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(2000) });
  if (Number(response.headers.get('content-length') ?? 0) > 131072) throw new Error('LIVE_CLOCK_BODY_TOO_LARGE');
  const body = await response.text();
  if (Buffer.byteLength(body) > 131072) throw new Error('LIVE_CLOCK_BODY_TOO_LARGE');
  return { url, startedAtMs, receivedAtMs: Date.now(), rttMs: performance.now() - began,
    status: response.status, body, bodySha256: createHash('sha256').update(body).digest('hex') };
}
/** Read-only external clock gate. It neither sets clocks nor transforms source timestamps. */
export async function checkLiveClock(output: string, request: Request = captureClock): Promise<void> {
  const captures: { kind: string; capture?: ClockCapture; result?: unknown; error?: string }[] = [];
  const inspect = async (kind: string, url: string, validate: (capture: ClockCapture) => unknown, init?: RequestInit) => {
    let capture: ClockCapture | undefined;
    try { capture = await request(url, init); captures.push({ kind, capture, result: validate(capture) }); }
    catch (error) { captures.push({ kind, ...(capture ? { capture } : {}), error: error instanceof Error ? error.message : String(error) }); }
  };
  for (let i = 0; i < LIVE_CLOCK_POLICY.samples; ++i)
    await inspect('polymarket-time', 'https://clob.polymarket.com/time', validateLiveTimeCapture);
  const rpc = (method: string, params: unknown[]) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  await inspect('monad-chain', 'https://testnet-rpc.monad.xyz', validateLiveMonadChain, rpc('eth_chainId', []));
  for (let i = 0; i < LIVE_CLOCK_POLICY.samples; ++i)
    await inspect('monad-latest', 'https://testnet-rpc.monad.xyz', validateLiveMonadCapture, rpc('eth_getBlockByNumber', ['latest', false]));
  const passed = captures.every(capture => capture.error === undefined);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ mode: 'READ_ONLY_LIVE_CLOCK_PREFLIGHT', passed, policy: LIVE_CLOCK_POLICY,
    checkedAtMs: Date.now(), captures, transactionsSent: 0, systemClockChanged: false,
    caveat: 'HTTPS server time and independent public chain corroboration are a bounded preflight, not authenticated NTP or a guarantee against later clock drift.' }, null, 2) + '\n', { flag: 'wx' });
  if (!passed) throw new Error(`LIVE_CLOCK_PREFLIGHT_FAILED:${output}`);
}
