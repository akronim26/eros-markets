/**
 * Operator gas top-up from the root deployer and operator notifications.
 *
 * When an operator wallet has less than `triggerMinutes` of projected runway (or has already
 * reached its stop), root sends that role's refill. Limits: one refill per role per
 * `cooldownMinutes`, at most `dailyCapMon` per UTC day, and root never goes below
 * `rootReserveMon`. When root cannot pay, nothing is sent and the operator is notified.
 * Only this market's own operator addresses can receive; never the user's wallet.
 */
import { execFile } from 'node:child_process';
import { MON } from './gas-runway.mjs';

const mon = value => {
  if (!Number.isFinite(value) || value < 0) throw Error('INVALID_TOPUP_AMOUNT');
  return BigInt(Math.round(value * 1e6)) * (MON / 1_000_000n);
};

export function topUpConfig(input) {
  if (input === undefined) return null;
  const num = (name, fallback, low, high) => {
    const v = input[name] ?? fallback;
    if (typeof v !== 'number' || !(v >= low && v <= high)) throw Error(`INVALID_TOPUP_${name.toUpperCase()}`);
    return v;
  };
  if (typeof input.rootEnvFile !== 'string') throw Error('TOPUP_ROOT_ENV_FILE_REQUIRED');
  const amounts = input.amountsMon ?? { KEEPER: 30, PUBLISHER: 15, MAKER_BUY: 5, MAKER_SELL: 5 };
  for (const [role, v] of Object.entries(amounts))
    if (!['KEEPER', 'PUBLISHER', 'MAKER_BUY', 'MAKER_SELL'].includes(role) || !(v > 0 && v <= 200)) throw Error('INVALID_TOPUP_AMOUNTS');
  return {
    rootEnvFile: input.rootEnvFile,
    triggerMinutes: num('triggerMinutes', 90, 10, 1440),
    cooldownMinutes: num('cooldownMinutes', 30, 1, 1440),
    dailyCapWei: mon(num('dailyCapMon', 200, 1, 10_000)),
    rootReserveWei: mon(num('rootReserveMon', 10, 0, 10_000)),
    amountsWei: Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, mon(v)])),
  };
}

const day = ms => new Date(ms).toISOString().slice(0, 10);

/** Pure decision for one runway report. Returns refills to send and notices to show. */
export function planTopUps({ rows, config, rootBalanceWei, history, nowMs }) {
  const today = day(nowMs);
  let spentToday = history.filter(h => day(h.atMs) === today).reduce((s, h) => s + h.amountWei, 0n);
  let available = rootBalanceWei;
  const sends = [], notices = [];
  for (const row of rows) {
    const amount = config.amountsWei[row.role];
    if (!amount || (row.level !== 'stopped' && row.minutes >= config.triggerMinutes)) continue;
    const last = history.filter(h => h.address.toLowerCase() === row.address.toLowerCase()).at(-1);
    if (last && nowMs - last.atMs < config.cooldownMinutes * 60_000) continue;
    if (spentToday + amount > config.dailyCapWei) {
      notices.push({ key: `cap:${today}`, title: 'Eros: top-up cap reached', message: `${row.market} ${row.role} needs MON; today's auto top-up cap is used. Top up manually.` });
      continue;
    }
    if (available < amount + config.rootReserveWei) {
      notices.push({ key: `root-low:${row.role}`, title: 'Eros: root wallet too low', message: `${row.market} ${row.role} needs MON but root cannot pay without going below its reserve. Fund the root deployer.` });
      continue;
    }
    sends.push({ market: row.market, role: row.role, address: row.address, amountWei: amount });
    spentToday += amount; available -= amount;
  }
  return { sends, notices };
}

/** Sends planned refills one by one from root; stops at the first failure. */
export async function sendTopUps({ sends, client, wallet, root }) {
  const results = [];
  for (const send of sends) {
    const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: root, blockTag })));
    if (latest !== pending) throw Error('ROOT_PENDING_TRANSACTION');
    const hash = await wallet.sendTransaction({ to: send.address, value: send.amountWei, nonce: latest, gas: 21_000n });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw Error('TOPUP_REVERTED');
    results.push({ ...send, hash });
  }
  return results;
}

/** Desktop notification on macOS; elsewhere (Render) a no-op that still logs through the caller. */
export function macNotifier({ platform = process.platform, run = execFile } = {}) {
  return (title, message) => {
    if (platform !== 'darwin') return;
    const quote = s => String(s).replace(/[\\"]/g, '').slice(0, 200);
    run('osascript', ['-e', `display notification "${quote(message)}" with title "${quote(title)}" sound name "Submarine"`], () => {});
  };
}

/** One notification per key until the condition clears. */
export class NoticeOnce {
  constructor(notify) { this.notify = notify; this.shown = new Set(); }
  show({ key, title, message }) { if (this.shown.has(key)) return false; this.shown.add(key); this.notify(title, message); return true; }
  clear(prefix) { for (const k of [...this.shown]) if (k.startsWith(prefix)) this.shown.delete(k); }
}
