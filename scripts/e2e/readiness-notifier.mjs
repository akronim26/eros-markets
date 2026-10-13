import fs from 'node:fs';

/** Coordination notices that can change maker readiness. Each is only a wake-up hint. */
export const READINESS_NOTICES = Object.freeze([
  'index-notice.json', // publisher: a finalized authenticated INDEX observation
  'sample-request.json', // publisher: a capture request for that observation
  'sample-ack.json', // keeper: a capture/seal outcome
  'pricing-notice.json', // keeper: finalized pricing activation or rollover
]);

/**
 * Event-driven wait for worker readiness. `wait(maxMs)` resolves early when the publisher or
 * keeper writes a notice and otherwise after `maxMs`, so a missed or absent notification can only
 * fall back to the previous polling delay. Waking never authorizes anything: the caller rereads
 * finalized chain state and simulates every action.
 */
export class ReadinessNotifier {
  constructor({ directory, watch = fs.watch, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.directory = directory;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.waiters = new Set();
    this.version = 0;
    this.watcher = null;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      this.watcher = watch(directory, { persistent: false }, (_event, name) => {
        // Atomic writers rename `<notice>.tmp` onto the notice; some platforms omit the name.
        if (name && !READINESS_NOTICES.some(notice => name === notice || name === notice + '.tmp')) return;
        this.notify();
      });
      this.watcher.on?.('error', () => this.closeWatcher());
    } catch {
      this.watcher = null; // Polling fallback only; correctness never depends on a notice.
    }
  }

  get watching() { return this.watcher !== null; }

  notify() {
    ++this.version;
    for (const resolve of [...this.waiters]) resolve('notified');
  }

  wait(maxMs, since = this.version) {
    if (!(maxMs >= 0)) throw Error('INVALID_READINESS_WAIT');
    if (maxMs === 0) return Promise.resolve('timeout');
    if (this.version !== since) return Promise.resolve('notified');
    return new Promise(resolve => {
      const done = reason => {
        this.clearTimer(timer);
        this.waiters.delete(done);
        resolve(reason);
      };
      const timer = this.setTimer(() => done('timeout'), maxMs);
      this.waiters.add(done);
    });
  }

  closeWatcher() {
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
  }

  close() {
    this.closeWatcher();
    for (const resolve of [...this.waiters]) resolve('closed');
  }
}

/** Atomic notice write shared by workers; the reader treats it only as a hint. */
export function writeNotice(directory, name, value) {
  if (!directory) return;
  if (!READINESS_NOTICES.includes(name)) throw Error('UNKNOWN_READINESS_NOTICE');
  const file = `${directory}/${name}`;
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
