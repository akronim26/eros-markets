/**
 * Operator gas runway: launch check and early alerts before a worker reaches its own stopping
 * threshold. Read-only; it never funds, signs or changes a worker's spending policy.
 *
 * Monad charges the full gas limit, so projected spend uses gas limits, not gas used. Each
 * stopping threshold mirrors the worker's own pre-signing balance check:
 *   publisher: balance < relay.maxCostWei (MONAD_SENDER_NEEDS_TEST_MON)
 *   keeper:    balance < prepared gas * 150 gwei + 0.1 MON (KEEPER_NEEDS_TEST_MON)
 *   maker:     balance < prepared gas * 150 gwei + 0.1 MON ("maker gas wallet below policy minimum")
 * Thresholds use each worker's maximum prepared gas, the earliest point it can stop.
 */
export const GWEI = 10n ** 9n;
export const MON = 10n ** 18n;
export const WORKER_MAX_FEE_WEI = 150n * GWEI;
export const WORKER_PRIORITY_FEE_WEI = 2n * GWEI;
export const WORKER_RESERVE_WEI = MON / 10n;
export const MAKER_MAX_GAS = 2_000_000n;
export const SOURCE_INTERVAL_SECONDS = 12n; // Measured October 9 median publication/capture cadence.
export const ROLLOVER_TRANSACTIONS_PER_HOUR = 4n; // Begin/page/finish or one batch, plus activation.
export const MAKER_CLEANUP_BATCHES_PER_HOUR = 3n;

export function gasRunwayConfig(input = {}) {
  const value = (name, fallback, low, high) => {
    const v = input[name] ?? fallback;
    if (!Number.isInteger(v) || v < low || v > high) throw Error(`INVALID_GAS_RUNWAY_${name.toUpperCase()}`);
    return v;
  };
  const launchMinutes = value('launchMinutes', 120, 10, 1440);
  const alertMinutes = value('alertMinutes', 30, 5, 720);
  if (alertMinutes >= launchMinutes) throw Error('GAS_RUNWAY_ALERT_MUST_PRECEDE_LAUNCH_REQUIREMENT');
  return { launchMinutes, alertMinutes, checkIntervalMs: value('checkIntervalMs', 60_000, 5_000, 600_000) };
}

/** Price paid per gas unit now: base fee plus priority, capped by the workers' max fee. */
export function effectiveGasPrice(baseFeePerGas) {
  if (typeof baseFeePerGas !== 'bigint' || baseFeePerGas < 0n) throw Error('INVALID_BASE_FEE');
  const price = baseFeePerGas + WORKER_PRIORITY_FEE_WEI;
  return price < WORKER_MAX_FEE_WEI ? price : WORKER_MAX_FEE_WEI;
}

const big = (value, name) => {
  const v = typeof value === 'bigint' ? value : /^\d+$/.test(String(value)) ? BigInt(value) : undefined;
  if (v === undefined || v <= 0n) throw Error(`INVALID_GAS_RUNWAY_INPUT_${name}`);
  return v;
};

/** Stopping threshold and conservative hourly gas-limit consumption for each operator role. */
export function roleBudgets({ publisherRelay, keeperMaxGas, samplePerpGas, makerMaxActionsPerEpoch }) {
  const publisherGas = big(publisherRelay?.gasCap, 'PUBLISHER_GAS');
  const keeperGas = big(keeperMaxGas, 'KEEPER_GAS');
  const sampleGas = big(samplePerpGas ?? keeperMaxGas, 'SAMPLE_GAS');
  const makerActions = big(makerMaxActionsPerEpoch, 'MAKER_ACTIONS');
  const perHour = 3600n / SOURCE_INTERVAL_SECONDS;
  const worker = gas => gas * WORKER_MAX_FEE_WEI + WORKER_RESERVE_WEI;
  const maker = { stopWei: worker(MAKER_MAX_GAS), gasPerHour: (makerActions + MAKER_CLEANUP_BATCHES_PER_HOUR) * MAKER_MAX_GAS };
  return [
    { role: 'PUBLISHER', stopWei: big(publisherRelay.maxCostWei, 'PUBLISHER_STOP'), gasPerHour: perHour * publisherGas },
    { role: 'KEEPER', stopWei: worker(keeperGas), gasPerHour: perHour * sampleGas + ROLLOVER_TRANSACTIONS_PER_HOUR * keeperGas },
    { role: 'MAKER_BUY', ...maker },
    { role: 'MAKER_SELL', ...maker },
  ];
}

/** Minutes until the role reaches its stopping threshold at the projected rate. */
export function assessRunway({ budget, balanceWei, gasPriceWei, config }) {
  if (typeof balanceWei !== 'bigint' || balanceWei < 0n || typeof gasPriceWei !== 'bigint' || gasPriceWei <= 0n)
    throw Error('INVALID_GAS_RUNWAY_READING');
  const spendPerHourWei = budget.gasPerHour * gasPriceWei;
  const headroomWei = balanceWei > budget.stopWei ? balanceWei - budget.stopWei : 0n;
  // Floor: a partial minute is never counted as runway.
  const minutes = Number(headroomWei * 60n / spendPerHourWei);
  const level = balanceWei < budget.stopWei ? 'stopped' : minutes < config.alertMinutes ? 'alert'
    : minutes < config.launchMinutes ? 'low' : 'ok';
  // Amount that restores the launch requirement; zero when already met.
  const required = budget.stopWei + spendPerHourWei * BigInt(config.launchMinutes) / 60n;
  return { role: budget.role, balanceWei, stopWei: budget.stopWei, spendPerHourWei, minutes, level,
    topUpForLaunchWei: required > balanceWei ? required - balanceWei : 0n };
}

export async function readGasRunway({ client, groups, config }) {
  const block = await client.getBlock({ blockTag: 'latest' });
  const gasPriceWei = effectiveGasPrice(block.baseFeePerGas ?? 0n);
  const rows = [];
  for (const group of groups) {
    for (const budget of group.budgets) {
      const address = group.addresses[budget.role];
      const balanceWei = await client.getBalance({ address, blockNumber: block.number });
      rows.push({ market: group.name, address, ...assessRunway({ budget, balanceWei, gasPriceWei, config }) });
    }
  }
  return { block: block.number, gasPriceWei, rows };
}

/** Launch needs every operator above its threshold with `launchMinutes` of projected runway. */
export function launchShortfalls(report) {
  return report.rows.filter(row => row.level !== 'ok');
}

const mon = wei => `${wei / MON}.${(wei % MON).toString().padStart(18, '0').slice(0, 4)}`;
export function formatRunwayRow(row) {
  return { market: row.market, role: row.role, address: row.address, level: row.level, minutesLeft: row.minutes,
    balanceMon: mon(row.balanceWei), stopMon: mon(row.stopWei), spendPerHourMon: mon(row.spendPerHourWei),
    topUpForLaunchMon: mon(row.topUpForLaunchWei) };
}

/** Alert once per role per level, and again when the level worsens or recovers. */
export class RunwayAlerts {
  constructor() { this.levels = new Map(); }
  changes(report) {
    const out = [];
    for (const row of report.rows) {
      const key = `${row.market}:${row.role}`;
      const previous = this.levels.get(key) ?? 'ok';
      const current = row.level === 'low' ? 'ok' : row.level;
      if (current !== previous) out.push({ ...formatRunwayRow(row), previous });
      this.levels.set(key, current);
    }
    return out;
  }
}
