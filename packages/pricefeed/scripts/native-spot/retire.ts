#!/usr/bin/env bun
/** Retire a wallet's position in a superseded native market (NM-S10): cancel its open Kuru orders on
 *  both books, withdraw its Kuru margin balances, and merge every complete set back into tUSDC while
 *  the vault is unresolved (after resolution use `maker.ts settle`). Unpaired YES or NO stay in the
 *  wallet and remain redeemable at resolution.
 *
 *    D=oracle/deployments/native/<old>.json RPC=.. KEY=0x.. bun scripts/native-spot/retire.ts
 */
import { BOOK, C, MA, MARGIN, NB, NO, V, VAULT, YB, YES, balance, env, log, margin, openOrders, read, wallet } from './chain';
import type { Hex } from 'viem';

const w = wallet(env('KEY') as Hex);
for (const [side, book] of [['YES', YB], ['NO', NB]] as const) {
  const open = await openOrders(book, w.me, BigInt(env('SCAN_ORDERS', '2000')));
  if (open.length) await w.send(book, BOOK, 'batchCancelOrders', [open]);
  log('retire', `cancelled ${open.length} open ${side} order(s)`);
}
for (const t of [YES, NO, C]) { const m = await margin(w.me, t); if (m > 0n) await w.send(MARGIN, MA, 'withdraw', [m, t]); }
if (await read(V, VAULT, 'resolved')) { log('retire', 'vault already resolved: run maker.ts settle instead'); process.exit(0); }
const y = await balance(YES, w.me), n = await balance(NO, w.me), sets = y < n ? y : n;
if (sets > 0n) await w.send(V, VAULT, 'merge', [sets, w.me]);
log('retire', `merged ${Number(sets) / 1e6} sets; left ${Number(y - sets) / 1e6} YES, ${Number(n - sets) / 1e6} NO; wallet tUSDC ${Number(await balance(C, w.me)) / 1e6}`);
