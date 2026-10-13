import { UINT64_MAX } from './math.js';

export function sourceTime(timestamp: unknown, receivedAtMs: bigint, lastSourceMs: bigint | null, minimumHeadroomMs: bigint) {
  if (typeof timestamp !== 'string' || !/^\d{1,23}$/.test(timestamp)) throw new Error('MISSING_OR_BAD_SOURCE_TIME');
  const sourceMs = BigInt(timestamp), observedAt = sourceMs / 1000n;
  if (sourceMs === 0n || observedAt > UINT64_MAX || receivedAtMs < 0n || minimumHeadroomMs < 0n)
    throw new Error('BAD_TIME_BOUNDS');
  const sourceAgeMs = receivedAtMs - sourceMs;
  // Raw milliseconds also reject future skew hidden by a whole-second floor.
  const fresh = sourceAgeMs >= 0n && receivedAtMs / 1000n - observedAt <= 30n;
  const headroomMs = (observedAt + 30n) * 1000n - receivedAtMs;
  return { sourceMs, observedAt, sourceAgeMs, fresh, headroomMs,
    hasHeadroom: fresh && headroomMs >= minimumHeadroomMs,
    monotone: lastSourceMs === null || sourceMs >= lastSourceMs,
    advanced: lastSourceMs === null || sourceMs > lastSourceMs };
}
