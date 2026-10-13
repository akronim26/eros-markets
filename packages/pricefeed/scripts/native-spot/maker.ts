#!/usr/bin/env bun
/** Eros liquidity for a native spot prediction market on Kuru (NM-S07).
 *
 *  One maker, both books. It holds complete sets (split from tUSDC) and quotes
 *    YES  fair − H / fair + H        NO  (1000 − fair) − H / (1000 − fair) + H     (ticks = price × 1000)
 *  so YES ask + NO ask = 1000 + 2H and YES bid + NO bid = 1000 − 2H: our own quotes never offer a
 *  split/merge arbitrage. There is no probability model: `fair` starts at the operator-chosen
 *  OPEN_TICK and moves only with this maker's own fills (net YES demand raises it, net NO demand
 *  lowers it), bounded per loop and to [MIN_TICK, 1000 − MIN_TICK]. Inventory limits widen nothing;
 *  they stop quoting the side that would exceed MAX_NET_CLAIMS.
 *  It cancels every quote and stops STOP_BEFORE_T_SECS before tip-off (no in-game quoting).
 *
 *    D=<deployment.json> RPC=.. MAKER_KEY=0x.. OPEN_TICK=520 bun scripts/native-spot/maker.ts
 *    ... bun scripts/native-spot/maker.ts settle      # after resolution: withdraw and redeem
 *
 *  Optional: HALF_SPREAD_TICKS (15), QUOTE_CLAIMS (100), STEP_TICKS (4 per QUOTE_CLAIMS of net flow),
 *  MAX_MOVE_TICKS (10 per loop), MAX_NET_CLAIMS (600), MIN_TICK (30), EVERY_MS (60000),
 *  STOP_BEFORE_T_SECS (60), STATE (maker-state.json next to D).
 */
import { C, D, MA, MARGIN, NB, NO, T, V, VAULT, YB, YES, BOOK, ERC20, balance, createdOrders, env, log, loadState, margin, nowSecs, openOrders, read, saveState, settleWallet, sleep, wallet } from './chain';
import type { Address, Hex } from 'viem';

const w = wallet(env('MAKER_KEY') as Hex);
if (process.argv[2] === 'settle') { await settleWallet(w, 'maker'); process.exit(0); }

const H = Number(env('HALF_SPREAD_TICKS', '15')), Q = Number(env('QUOTE_CLAIMS', '100'));
const STEP = Number(env('STEP_TICKS', '4')), MAX_MOVE = Number(env('MAX_MOVE_TICKS', '10'));
const MAX_NET = Number(env('MAX_NET_CLAIMS', '600')), MIN_TICK = Number(env('MIN_TICK', '30'));
const EVERY = Number(env('EVERY_MS', '60000')), STOP = Number(env('STOP_BEFORE_T_SECS', '60'));
const STATE = env('STATE', env('D').replace(/\.json$/, '.maker-state.json'));
const ATOMS = 1_000_000n, LOTS = BigInt(Q * 1000), SET_ATOMS = BigInt(Q) * ATOMS;

type State = { fair: number; netYesClaims: number; last: { yes: string; no: string } | null; orders: { yes: string[]; no: string[] } };
const s = loadState<State>(STATE, { fair: Number(env('OPEN_TICK')), netYesClaims: 0, last: null, orders: { yes: [], no: [] } });
if (!(s.fair >= MIN_TICK && s.fair <= 1000 - MIN_TICK)) throw new Error('OPEN_TICK_OUT_OF_RANGE');
const clamp = (x: number) => Math.max(MIN_TICK, Math.min(1000 - MIN_TICK, Math.round(x)));
const total = async (t: Address) => (await balance(t, w.me)) + (await margin(w.me, t));

/** Keep at least two quotes' worth of YES, NO and tUSDC in the Kuru margin account. */
async function ensureInventory() {
  for (const t of [YES, NO]) {
    const m = await margin(w.me, t);
    if (m >= 2n * SET_ATOMS) continue;
    if ((await balance(t, w.me)) < 2n * SET_ATOMS) {
      if (!(await read(V, VAULT, 'issuanceOpen'))) continue; // no new sets after tip-off; quote what is held
      const need = 4n * SET_ATOMS;
      if ((await balance(C, w.me)) < need) await w.send(C, ERC20, 'mint', [w.me, need]); // tUSDC faucet
      await w.send(C, ERC20, 'approve', [V, need]);
      await w.send(V, VAULT, 'split', [need, w.me]);
      log('maker', `split ${Number(need / ATOMS)} complete sets`);
    }
    const amt = await balance(t, w.me);
    await w.send(t, ERC20, 'approve', [MARGIN, amt]);
    await w.send(MARGIN, MA, 'deposit', [w.me, t, amt]);
  }
  const mc = await margin(w.me, C);
  if (mc < 2n * SET_ATOMS) {
    const need = 4n * SET_ATOMS;
    if ((await balance(C, w.me)) < need) await w.send(C, ERC20, 'mint', [w.me, need]);
    await w.send(C, ERC20, 'approve', [MARGIN, need]);
    await w.send(MARGIN, MA, 'deposit', [w.me, C, need]);
  }
}

async function cancelAll() {
  for (const [side, book] of [['yes', YB], ['no', NB]] as const) {
    const open = await openOrders(book, w.me);
    if (open.length) await w.send(book, BOOK, 'batchCancelOrders', [open]);
    s.orders[side] = [];
    if (open.length) log('maker', `cancelled ${open.length} ${side.toUpperCase()} order(s)`);
  }
  saveState(STATE, s);
}

async function quote(side: 'yes' | 'no', bid: number | null, ask: number | null) {
  const book = side === 'yes' ? YB : NB, ids: bigint[] = [];
  if (bid !== null) ids.push(...createdOrders(await w.send(book, BOOK, 'addBuyOrder', [bid, LOTS, true]), w.me));
  if (ask !== null) ids.push(...createdOrders(await w.send(book, BOOK, 'addSellOrder', [ask, LOTS, true]), w.me));
  s.orders[side] = ids.map(String);
}

log('maker', `market ${D.marketId.slice(0, 10)}… tip-off ${new Date(T * 1000).toISOString()} fair ${s.fair} H ${H} size ${Q}`);
await cancelAll(); // leftovers from an earlier run would make post-only quotes cross
let prevYes = await total(YES), prevNo = await total(NO);
while (nowSecs() < T - STOP) {
  try {
    await ensureInventory();
    // Net flow since the last loop from inventory alone (splits add YES and NO equally, so they cancel).
    const y = await total(YES), n = await total(NO);
    const flow = (Number(prevYes - y) - Number(prevNo - n)) / 1e6; // >0: takers net bought YES / sold NO
    prevYes = y; prevNo = n;
    s.netYesClaims += flow;
    const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, (flow / Q) * STEP));
    s.fair = clamp(s.fair + move);
    // Inventory guard: once takers are net long MAX_NET YES, stop selling more YES (and buying NO).
    const longCap = s.netYesClaims >= MAX_NET, shortCap = s.netYesClaims <= -MAX_NET;
    const yb = clamp(s.fair - H), ya = clamp(s.fair + H);
    const yesQ = { bid: shortCap ? null : yb, ask: longCap ? null : ya };
    const noQ = { bid: longCap ? null : 1000 - ya, ask: shortCap ? null : 1000 - yb };
    const key = (q: typeof yesQ) => `${q.bid}/${q.ask}`;
    const stillOpen = async (side: 'yes' | 'no') => (await openOrders(side === 'yes' ? YB : NB, w.me, 60n)).length;
    const want = { yes: key(yesQ), no: key(noQ) };
    const expected = (q: typeof yesQ) => Number(q.bid !== null) + Number(q.ask !== null);
    for (const side of ['yes', 'no'] as const) {
      const q = side === 'yes' ? yesQ : noQ;
      if (s.last?.[side] === want[side] && (await stillOpen(side)) === expected(q)) continue;
      const open = await openOrders(side === 'yes' ? YB : NB, w.me);
      if (open.length) await w.send(side === 'yes' ? YB : NB, BOOK, 'batchCancelOrders', [open]);
      await quote(side, q.bid, q.ask);
      log('maker', `${side.toUpperCase().padEnd(3)} ${q.bid ?? '-'}/${q.ask ?? '-'}  fair ${s.fair} flow ${flow >= 0 ? '+' : ''}${flow.toFixed(1)} net ${s.netYesClaims.toFixed(1)}`);
    }
    s.last = want;
    saveState(STATE, s);
  } catch (e) { log('maker', `error: ${String(e).slice(0, 200)}`); }
  await sleep(Math.min(EVERY, Math.max(1000, (T - STOP - nowSecs()) * 1000)));
}
await cancelAll();
log('maker', 'stopped before tip-off; all quotes cancelled. Run `maker.ts settle` after resolution.');
