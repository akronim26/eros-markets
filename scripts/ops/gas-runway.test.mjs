import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRunway, effectiveGasPrice, gasRunwayConfig, GWEI, launchShortfalls, MON, readGasRunway, roleBudgets, RunwayAlerts } from './gas-runway.mjs';

const relay = { gasCap: '800000', maxCostWei: '120000000000000000' };
const budgets = roleBudgets({ publisherRelay: relay, keeperMaxGas: '3000000', samplePerpGas: 1_000_000, makerMaxActionsPerEpoch: 12 });
const byRole = Object.fromEntries(budgets.map(b => [b.role, b]));
const config = gasRunwayConfig({});

test('stopping thresholds match each worker pre-signing balance check', () => {
  assert.equal(byRole.PUBLISHER.stopWei, 12n * 10n ** 16n); // relay.maxCostWei
  assert.equal(byRole.KEEPER.stopWei, 3_000_000n * 150n * GWEI + MON / 10n); // 0.55 MON
  assert.equal(byRole.MAKER_BUY.stopWei, 2_000_000n * 150n * GWEI + MON / 10n); // 0.4 MON
  assert.equal(byRole.MAKER_SELL.stopWei, byRole.MAKER_BUY.stopWei);
});

test('hourly spend charges gas limits at the projected cadence', () => {
  assert.equal(byRole.PUBLISHER.gasPerHour, 300n * 800_000n);
  assert.equal(byRole.KEEPER.gasPerHour, 300n * 1_000_000n + 4n * 3_000_000n);
  assert.equal(byRole.MAKER_BUY.gasPerHour, 15n * 2_000_000n);
  assert.equal(effectiveGasPrice(50n * GWEI), 52n * GWEI);
  assert.equal(effectiveGasPrice(200n * GWEI), 150n * GWEI, 'capped by the workers max fee');
});

test('runway levels: stopped below threshold, alert before it, low below the launch requirement', () => {
  const price = 52n * GWEI;
  const maker = byRole.MAKER_BUY; // 30M gas/h at 52 gwei = 1.56 MON/h, stop 0.4 MON.
  const at = balanceWei => assessRunway({ budget: maker, balanceWei, gasPriceWei: price, config });
  assert.equal(at(399_999_999_999_999_999n).level, 'stopped');
  const thirtyMinutes = maker.stopWei + 78n * 10n ** 16n; // 0.78 MON = 30 minutes.
  assert.equal(at(thirtyMinutes).minutes, 30);
  assert.equal(at(thirtyMinutes).level, 'low');
  assert.equal(at(thirtyMinutes - 1n).level, 'alert');
  const launch = maker.stopWei + 312n * 10n ** 16n; // 3.12 MON = 120 minutes.
  assert.equal(at(launch).level, 'ok');
  assert.equal(at(launch).topUpForLaunchWei, 0n);
  assert.equal(at(launch - 10n).level, 'low');
  assert.equal(at(launch - 10n).topUpForLaunchWei, 10n);
});

test('configuration requires the alert to precede the launch requirement', () => {
  assert.throws(() => gasRunwayConfig({ launchMinutes: 30, alertMinutes: 30 }), /ALERT_MUST_PRECEDE/);
  assert.throws(() => gasRunwayConfig({ launchMinutes: 5 }), /LAUNCHMINUTES/);
  assert.deepEqual(gasRunwayConfig({ launchMinutes: 60, alertMinutes: 15 }), { launchMinutes: 60, alertMinutes: 15, checkIntervalMs: 60_000 });
  assert.throws(() => roleBudgets({ publisherRelay: relay, keeperMaxGas: 0, makerMaxActionsPerEpoch: 12 }), /KEEPER_GAS/);
});

test('launch check reads every operator at one block and reports shortfalls', async () => {
  const balances = { '0xP': 50n * MON, '0xK': 20n * MON, '0xB': 3n * MON, '0xS': 10n * MON };
  // Keeper: 312M gas/h at 52 gwei = 16.224 MON/h, so 20 MON lasts ~72 minutes (October 9: 82).
  const reads = [];
  const client = {
    getBlock: async () => ({ number: 9n, baseFeePerGas: 50n * GWEI }),
    getBalance: async ({ address, blockNumber }) => { reads.push(blockNumber); return balances[address]; },
  };
  const report = await readGasRunway({ client, config, groups: [{ name: 'btc', budgets,
    addresses: { PUBLISHER: '0xP', KEEPER: '0xK', MAKER_BUY: '0xB', MAKER_SELL: '0xS' } }] });
  assert.deepEqual(reads, [9n, 9n, 9n, 9n]);
  assert.equal(report.gasPriceWei, 52n * GWEI);
  // The October 9 maker funding (3 MON) is below a 2-hour runway at 12 actions per epoch.
  assert.deepEqual(launchShortfalls(report).map(r => r.role), ['KEEPER', 'MAKER_BUY']);
});

test('alerts fire on entering alert/stopped and on recovery, not on every check', () => {
  const alerts = new RunwayAlerts();
  const row = level => ({ rows: [{ market: 'btc', role: 'KEEPER', address: '0xK', level, minutes: 10,
    balanceWei: MON, stopWei: MON / 2n, spendPerHourWei: MON, topUpForLaunchWei: 0n }] });
  assert.equal(alerts.changes(row('ok')).length, 0);
  assert.equal(alerts.changes(row('low')).length, 0);
  assert.equal(alerts.changes(row('alert'))[0].level, 'alert');
  assert.equal(alerts.changes(row('alert')).length, 0);
  assert.equal(alerts.changes(row('stopped'))[0].previous, 'alert');
  assert.equal(alerts.changes(row('ok'))[0].level, 'ok');
});
