/**
 * Any engine action after a capture changes the book revision, so the next sample discards that
 * capture. Detect the action from the engine's own logs and capture the new book at once; sealing
 * still needs a strictly newer authenticated INDEX observation, which the paced testnet publisher
 * sends early on request (index-pacing.mjs).
 */
export const BOOK_CHANGE_SCAN_MS = 1_000;
export const BOOK_CHANGE_MAX_RANGE = 10n; // Some providers reject wider eth_getLogs ranges.
export const BOOK_CHANGE_MIN_SAMPLE_MS = 20_000; // At most one extra sample+INDEX cycle per 20 s.

// Sampling and source ingress never change the book revision.
const SAMPLER_TOPICS = new Set([
  'ObservationAccepted', 'PerpObservationRecorded', 'BookDepthCaptured', 'PricingModeChanged',
]);

export class BookChangeWatch {
  constructor({ client, engine, decode, now = Date.now }) {
    this.client = client; this.engine = engine; this.now = now; this.decode = decode;
    this.cursor = undefined; this.changedAt = undefined; this.lastScan = 0; this.lastTriggered = -Infinity;
  }

  /** The capture is in `captureBlock`; only later actions can discard it. */
  captured(captureBlock) {
    if (typeof captureBlock !== 'bigint') return;
    if (this.changedAt !== undefined && this.changedAt <= captureBlock) this.changedAt = undefined;
    if (this.cursor === undefined || this.cursor < captureBlock) this.cursor = captureBlock;
  }

  /** Scan new blocks at most once per BOOK_CHANGE_SCAN_MS. Returns the first change block. */
  async scan(head) {
    if (this.cursor === undefined || this.now() - this.lastScan < BOOK_CHANGE_SCAN_MS) return this.changedAt;
    this.lastScan = this.now();
    if (typeof head === 'function') head = await head();
    while (this.cursor < head && this.changedAt === undefined) {
      const from = this.cursor + 1n, to = head - this.cursor > BOOK_CHANGE_MAX_RANGE ? this.cursor + BOOK_CHANGE_MAX_RANGE : head;
      const logs = await this.client.getLogs({ address: this.engine, fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (log.address?.toLowerCase() !== this.engine.toLowerCase()) continue;
        const name = this.decode(log);
        if (!SAMPLER_TOPICS.has(name)) { this.changedAt = log.blockNumber; break; }
      }
      this.cursor = to;
    }
    return this.changedAt;
  }

  /** A sample is due once a book change follows the current capture, at a bounded rate. */
  due() {
    if (this.changedAt === undefined || this.now() - this.lastTriggered < BOOK_CHANGE_MIN_SAMPLE_MS) return false;
    return true;
  }

  triggered() { this.lastTriggered = this.now(); }
}
