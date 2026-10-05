import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

/** Test-harness wait only: a timer firing is not evidence that a wall-clock lease expired. */
export async function waitForExpiredLease(readDeadline: () => number, options: {
  now?: () => number; elapsed?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number;
} = {}): Promise<{ waitedMs: number; deadline: number; observedNow: number }> {
  const now = options.now ?? Date.now, elapsed = options.elapsed ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = elapsed(), timeout = options.timeoutMs ?? 20000;
  for (;;) {
    const deadline = readDeadline(), observedNow = now(), waitedMs = elapsed() - started;
    if (observedNow >= deadline + 50) return { waitedMs, deadline, observedNow };
    if (waitedMs >= timeout) throw new Error('CRASH_LEASE_EXPIRY_WAIT_TIMEOUT');
    await sleep(Math.min(100, Math.max(1, deadline + 50 - observedNow), timeout - waitedMs));
  }
}

/** Read-only inventory. Never renew, shorten, delete or force a crashed writer's lease. */
export function crashedLeaseDeadline(directory: string): number {
  const tables = [['source', 'writers'], ['packets', 'packet_workers'], ['relay', 'relay_nonce']];
  let deadline = 0;
  for (const [name, table] of tables) {
    const db = new DatabaseSync(join(directory, `${name}.sqlite`), { readOnly: true });
    try {
      for (const row of db.prepare(`SELECT until_ms FROM ${table}`).all()) deadline = Math.max(deadline, Number(row.until_ms));
    } finally { db.close(); }
  }
  return deadline;
}
