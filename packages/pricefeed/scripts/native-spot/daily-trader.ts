#!/usr/bin/env bun
/** Eros daily trader for a native spot market (NM-S08): one real taker trade per UTC day.
 *
 *  Once per UTC day, at or after TRADE_UTC_HOUR, it market-buys TRADE_CLAIMS of one outcome on its
 *  Kuru book, alternating YES and NO by day number, and holds the tokens to resolution. A trade is
 *  skipped (and retried next loop) when the ask is missing or the expected fill would cost more than
 *  MAX_PRICE_TICK per claim; the order carries a minimum-output limit of MIN_FILL_PCT of the target.
 *  It never trades from STOP_BEFORE_T_SECS before tip-off. The day's trade is recorded in STATE before
 *  the next one can happen, so restarts do not double-trade.
 *
 *    D=<deployment.json> RPC=.. TRADER_KEY=0x.. bun scripts/native-spot/daily-trader.ts
 *    ... bun scripts/native-spot/daily-trader.ts settle    # after resolution: withdraw and redeem
 *
 *  Optional: TRADE_UTC_HOUR (17), TRADE_CLAIMS (10), MAX_PRICE_TICK (950), MIN_FILL_PCT (90),
 *  CHECK_EVERY_MS (300000), STOP_BEFORE_T_SECS (60), STATE (trader-state.json next to D).
 */
import { C, ERC20, MA, MARGIN, NB, T, YB, BOOK, balance, env, loadState, log, margin, nowSecs, saveState, settleWallet, sleep, topOfBook, wallet } from './chain';
import type { Hex } from 'viem';

const w = wallet(env('TRADER_KEY') as Hex);
if (process.argv[2] === 'settle') { await settleWallet(w, 'trader'); process.exit(0); }

const HOUR = Number(env('TRADE_UTC_HOUR', '17')), CLAIMS = Number(env('TRADE_CLAIMS', '10'));
const MAX_TICK = Number(env('MAX_PRICE_TICK', '950')), MIN_FILL = Number(env('MIN_FILL_PCT', '90'));
const EVERY = Number(env('CHECK_EVERY_MS', '300000')), STOP = Number(env('STOP_BEFORE_T_SECS', '60'));
const STATE = env('STATE', env('D').replace(/\.json$/, '.trader-state.json'));
type Trade = { day: string; side: 'YES' | 'NO'; claims: number; askTick: number; spentUnits: string; tx: string };
const s = loadState<{ trades: Trade[] }>(STATE, { trades: [] });

async function tradeToday(day: string) {
  const dayNo = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const side = dayNo % 2 === 0 ? 'YES' : 'NO', book = side === 'YES' ? YB : NB;
  const { ask } = await topOfBook(book);
  if (ask === null) { log('trader', `${day}: no ${side} ask on Kuru; retrying later`); return; }
  if (ask > MAX_TICK) { log('trader', `${day}: ${side} ask ${ask / 1000} above limit ${MAX_TICK / 1000}; retrying later`); return; }
  // Quote size is in 1/1000 collateral units: claims × ask tick. Fund the Kuru margin account first.
  const units = BigInt(CLAIMS * ask), atoms = units * 1000n;
  if ((await margin(w.me, C)) < atoms) {
    if ((await balance(C, w.me)) < atoms) await w.send(C, ERC20, 'mint', [w.me, atoms * 10n]); // tUSDC faucet
    await w.send(C, ERC20, 'approve', [MARGIN, atoms * 10n]);
    await w.send(MARGIN, MA, 'deposit', [w.me, C, atoms * 10n]);
  }
  const minLots = BigInt(Math.floor(CLAIMS * 1000 * MIN_FILL / 100));
  const r = await w.send(book, BOOK, 'placeAndExecuteMarketBuy', [units, minLots, true, false]);
  s.trades.push({ day, side, claims: CLAIMS, askTick: ask, spentUnits: units.toString(), tx: r.transactionHash });
  saveState(STATE, s);
  log('trader', `${day}: bought ~${CLAIMS} ${side} at ask ${ask / 1000} (tx ${r.transactionHash})`);
}

log('trader', `daily trader ${w.me}: ${CLAIMS} claims/day at ${HOUR}:00 UTC until ${new Date((T - STOP) * 1000).toISOString()}`);
while (nowSecs() < T - STOP) {
  const now = new Date(), day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= HOUR && !s.trades.some(t => t.day === day)) {
    try { await tradeToday(day); } catch (e) { log('trader', `${day}: trade failed: ${String(e).slice(0, 200)}`); }
  }
  await sleep(Math.min(EVERY, Math.max(1000, (T - STOP - nowSecs()) * 1000)));
}
log('trader', `stopped at tip-off after ${s.trades.length} trade(s). Run \`daily-trader.ts settle\` after resolution.`);
