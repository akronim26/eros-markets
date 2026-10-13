import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Simulated activity on a native market's Kuru books (demo tooling, NOT organic demand).
 *
 * - One market maker quotes YES and NO around a fair value it computes OUTSIDE Eros:
 *     fair = P(BTC > K at T) from the Kraken BTC/USD price (lognormal, annual vol SIM_VOL), or a bounded
 *     random walk (SIM_FAIR=walk). It never reads Eros INDEX/MARK (no circular pricing).
 *   Quotes are skewed by its own net YES position, so taker flow really moves the price.
 *   It re-quotes a book only when the target moves by >= 1 tick, to bound gas (bid + ask, then cancel the old pair).
 * - N takers place random market buys/sells of YES/NO (2..20 claims) every 20..90 s, each with a style:
 *   noise, momentum (follows the last move) or contrarian.
 *
 * Env: RPC, D (DeployNativeMarket JSON), MAKER_KEY, TAKER_KEYS (comma-separated), STRIKE (USD),
 *      SIM_FAIR (kraken|walk), SIM_VOL (default 0.5), HALF_SPREAD_TICKS (10), QUOTE_LOTS (150000),
 *      SKEW_TICKS_PER_100 (6), MAKER_EVERY_MS (30000), DURATION_MIN (60), CANCEL_ON_EXIT (0: keep last quotes).
 * Every amount is an integer in Kuru units: price units = ticks (1/1000), size units = lots (1/1000 claim).
 */
const MARGIN = getAddress('0xd029C2D98ff85D8F64799017fE00a59B1159CE02');
const BOOK = parseAbi([
  'function addBuyOrder(uint32 price, uint96 size, bool postOnly)',
  'function addSellOrder(uint32 price, uint96 size, bool postOnly)',
  'function batchCancelOrders(uint40[] orderIds)',
  'function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)',
  'function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)',
  'function bestBidAsk() view returns (uint256, uint256)',
  'event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)',
  'function s_orderIdCounter() view returns (uint40)',
  'function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)',
]);
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'function mint(address,uint256)']);
const MA = parseAbi(['function deposit(address,address,uint256)', 'function getBalance(address,address) view returns (uint256)']);
const VAULT = parseAbi(['function split(uint256,address)']);

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`MISSING_${k}`); return v; };
const D = JSON.parse(readFileSync(env('D'), 'utf8'));
const chain = defineChain({ id: 10143, name: 'monad-testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [env('RPC')] } } });
const pub = createPublicClient({ chain, transport: http(env('RPC'), { timeout: 20_000, retryCount: 2 }) });
const C = getAddress(D.collateral), YES = getAddress(D.yesToken), NO = getAddress(D.noToken);
const YB = getAddress(D.yesBook), NB = getAddress(D.noBook), V = getAddress(D.outcomeVault);
const T = Number(D.scheduledT), K = Number(env('STRIKE', '82500'));
const HALF = Number(env('HALF_SPREAD_TICKS', '10')), LOTS = BigInt(env('QUOTE_LOTS', '150000'));
const SKEW = Number(env('SKEW_TICKS_PER_100', '6')), VOL = Number(env('SIM_VOL', '0.5'));
const DURATION_MS = Number(env('DURATION_MIN', '60')) * 60_000;
let END = Date.now() + DURATION_MS + 10 * 60_000; // reset by the maker after startup cleanup
const log = (who: string, msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}Z ${who.padEnd(8)} ${msg}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function wallet(key: Hex) {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ chain, account, transport: http(env('RPC'), { timeout: 20_000 }) });
  // Estimate, then send with +30% gas limit (Monad charges the limit; stale estimates can run out of gas).
  async function send(address: Address, abi: any, functionName: string, args: readonly unknown[]) {
    const gas = await pub.estimateContractGas({ address, abi, functionName, args, account } as any);
    const hash = await w.writeContract({ address, abi, functionName, args, gas: gas * 13n / 10n } as any);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`REVERTED ${functionName} ${hash}`);
    return r;
  }
  return { account, send };
}

// ---------------------------------------------------------------- fair value (outside Eros)
const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
let walk = 0.5;
async function fair(): Promise<{ p: number; why: string }> {
  if (env('SIM_FAIR', 'kraken') === 'walk') { walk = Math.min(0.95, Math.max(0.05, walk + (Math.random() - 0.5) * 0.03)); return { p: walk, why: 'walk' }; }
  const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', { signal: AbortSignal.timeout(8000) });
  const s = Number((await r.json()).result.XXBTZUSD.c[0]);
  const tau = Math.max(T - Date.now() / 1000, 60) / (365 * 86400);
  const z = Math.log(s / K) / (VOL * Math.sqrt(tau));
  return { p: Math.min(0.97, Math.max(0.03, 0.5 * (1 + erf(z / Math.SQRT2)))), why: `BTC ${s.toFixed(0)}` };
}

// ---------------------------------------------------------------- market maker
async function maker() {
  const m = wallet(env('MAKER_KEY') as Hex), me = m.account.address;
  const ids: Record<string, bigint[]> = { yes: [], no: [] };
  const quoted: Record<string, [number, number] | null> = { yes: null, no: null };
  const bal = async (t: Address) => await pub.readContract({ address: MARGIN, abi: MA, functionName: 'getBalance', args: [me, t] });
  let depositedYes = 0n;
  async function ensureInventory() {
    const need = LOTS * 1000n * 2n; // 2 quotes' worth of base atoms (lots * 1e3 atoms/lot)
    for (const t of [YES, NO]) if (await bal(t) < need) {
      const w = await pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [me] });
      if (w < need) {
        await m.send(C, ERC20, 'mint', [me, need * 2n]); await m.send(C, ERC20, 'approve', [V, need * 2n]);
        await m.send(V, VAULT, 'split', [need * 2n, me]); log('maker', `split ${Number(need * 2n) / 1e6} sets for inventory`);
      }
      await m.send(t, ERC20, 'approve', [MARGIN, need]); await m.send(MARGIN, MA, 'deposit', [me, t, need]);
      if (t === YES) depositedYes += need;
    }
    if (await bal(C) < 200_000_000n) { await m.send(C, ERC20, 'mint', [me, 500_000_000n]); await m.send(C, ERC20, 'approve', [MARGIN, 500_000_000n]); await m.send(MARGIN, MA, 'deposit', [me, C, 500_000_000n]); }
  }
  async function requote(side: 'yes' | 'no', bid: number, ask: number) {
    const book = side === 'yes' ? YB : NB;
    const old = ids[side]!;
    const fresh: bigint[] = [];
    const post = async (fn: 'addBuyOrder' | 'addSellOrder', price: number) => {
      const r = await m.send(book, BOOK, fn, [price, LOTS, true]);
      for (const l of r.logs) { try { const e = decodeEventLog({ abi: BOOK, ...l } as any) as any; if (e.eventName === 'OrderCreated' && getAddress(e.args.owner) === me) fresh.push(BigInt(e.args.orderId)); } catch { /* other event */ } }
    };
    // Make-before-break: post the new bid and ask BEFORE cancelling the old ones, so the book is never
    // empty or one-sided between transactions (an observer read there yields an invalid-depth point,
    // which breaks the chart and resets INDEX coverage). Only if a new post-only quote would cross an
    // old one (large jump) fall back to cancel-first for that book.
    try {
      await post('addBuyOrder', bid); await post('addSellOrder', ask);
      if (old.length) await m.send(book, BOOK, 'batchCancelOrders', [old]).catch(e => log('maker', `cancel ${side} skipped: ${String(e).slice(0, 80)}`));
    } catch (e) {
      log('maker', `${side}: make-before-break crossed (${String(e).slice(0, 60)}); cancel-first fallback`);
      const all = [...old, ...fresh]; fresh.length = 0;
      if (all.length) await m.send(book, BOOK, 'batchCancelOrders', [all]).catch(() => {});
      await post('addBuyOrder', bid); await post('addSellOrder', ask);
    }
    ids[side] = fresh;
    quoted[side] = [bid, ask];
  }
  // Startup cleanup: cancel every order this maker still has open on either book. Leftover quotes
  // (e.g. the last quotes a previous run left resting) would make new post-only quotes cross.
  // Kuru's s_orders(id) gives owner + remaining size; walk the most recent SCAN_ORDERS ids.
  for (const [side, book] of [['yes', YB], ['no', NB]] as const) {
    const counter = BigInt(await pub.readContract({ address: book, abi: BOOK, functionName: 's_orderIdCounter' }) as any);
    const lo = counter > BigInt(env('SCAN_ORDERS', '400')) ? counter - BigInt(env('SCAN_ORDERS', '400')) : 1n;
    const open: bigint[] = [];
    for (let id = counter; id >= lo; id -= 1n) {
      const o = await pub.readContract({ address: book, abi: BOOK, functionName: 's_orders', args: [Number(id)] }) as any;
      if (getAddress(o[0]) === me && BigInt(o[1]) > 0n) open.push(id);
    }
    if (open.length) await m.send(book, BOOK, 'batchCancelOrders', [open]);
    log('maker', `startup: cancelled ${open.length} open ${side.toUpperCase()} order(s) of ours (scanned ids ${lo}..${counter})`);
  }
  END = Date.now() + DURATION_MS; // the run length starts after cleanup
  // Then measure the starting inventory, so freed ask inventory is not mistaken for taker flow.
  const startYes = await bal(YES);
  await ensureInventory();
  while (Date.now() < END) {
    try {
      const f = await fair();
      // Inventory skew: if takers bought YES from us (our margin YES fell), raise YES quotes.
      const sold = Number(startYes + depositedYes - await bal(YES)) / 1e6; // claims of YES net sold to takers (deposits excluded)
      const skew = Math.round((sold / 100) * SKEW);
      const mid = Math.round(f.p * 1000) + skew;
      const yb = Math.max(1, Math.min(998 - 2 * HALF, mid - HALF)), ya = yb + 2 * HALF;
      const nb = Math.max(1, 1000 - ya), na = Math.min(999, 1000 - yb);
      const moved = (q: [number, number] | null | undefined, b: number) => !q || Math.abs(q[0] - b) >= 1;
      if (moved(quoted.yes, yb)) { await requote('yes', yb, ya); log('maker', `YES ${yb / 1000}/${ya / 1000}  fair ${f.p.toFixed(3)} (${f.why}) skew ${skew}t`); }
      if (moved(quoted.no, nb)) { await requote('no', nb, na); log('maker', `NO  ${nb / 1000}/${na / 1000}`); }
      await ensureInventory();
    } catch (e) { log('maker', `error: ${String(e).slice(0, 160)}`); }
    await sleep(Number(env('MAKER_EVERY_MS', '30000')));
  }
  // Default: leave the last quotes resting so the market stays priced (INDEX valid) after the sim ends.
  if (env('CANCEL_ON_EXIT', '0') === '1') {
    for (const side of ['yes', 'no'] as const) if (ids[side]!.length) await m.send(side === 'yes' ? YB : NB, BOOK, 'batchCancelOrders', [ids[side]]).catch(() => {});
    log('maker', 'stopped; own quotes cancelled');
  } else {
    log('maker', `stopped; last quotes left resting (YES ${quoted.yes}, NO ${quoted.no}); the next run cancels them at startup`);
  }
}

// ---------------------------------------------------------------- takers
async function taker(key: Hex, n: number) {
  const t = wallet(key), me = t.account.address, name = `taker${n}`;
  const style = ['noise', 'momentum', 'contrarian'][n % 3]!;
  // Fund: mint collateral, split 100 sets, deposit YES/NO and collateral to Kuru margin. A taker that
  // cannot set up (e.g. no gas) logs and exits on its own; it never stops the maker or other takers.
  try {
    await t.send(C, ERC20, 'mint', [me, 400_000_000n]); await t.send(C, ERC20, 'approve', [V, 100_000_000n]);
    await t.send(V, VAULT, 'split', [100_000_000n, me]);
    for (const [tok, amt] of [[YES, 100_000_000n], [NO, 100_000_000n], [C, 250_000_000n]] as const) {
      await t.send(tok, ERC20, 'approve', [MARGIN, amt]); await t.send(MARGIN, MA, 'deposit', [me, tok, amt]);
    }
  } catch (e) { log(name, `setup failed, taker not running: ${String(e).slice(0, 120)}`); return; }
  log(name, `ready (${style})`);
  let last = 0;
  while (Date.now() < END) {
    await sleep(20_000 + Math.random() * 70_000);
    try {
      const [bid, ask] = await pub.readContract({ address: YB, abi: BOOK, functionName: 'bestBidAsk' });
      if (ask === 0n || bid >= 10n ** 30n) continue; // empty side
      const mid = Number((bid + ask) / 2n) / 1e18, move = mid - last; last = mid;
      let buyYes = Math.random() < 0.5;
      if (style === 'momentum' && Math.abs(move) > 0.001) buyYes = move > 0;
      if (style === 'contrarian' && Math.abs(move) > 0.001) buyYes = move < 0;
      const onYes = Math.random() < 0.7, claims = 2 + Math.floor(Math.random() * 19), lots = BigInt(claims * 1000);
      const book = onYes ? YB : NB, buy = onYes ? buyYes : !buyYes;
      if (buy) {
        const [, a] = await pub.readContract({ address: book, abi: BOOK, functionName: 'bestBidAsk' });
        const units = BigInt(claims) * (a / 10n ** 15n); // claims x ask tick = quote units (1/1000 collateral)
        await t.send(book, BOOK, 'placeAndExecuteMarketBuy', [units, 0n, true, false]);
      } else await t.send(book, BOOK, 'placeAndExecuteMarketSell', [lots, 0n, true, false]);
      log(name, `${buy ? 'BUY ' : 'SELL'} ${claims} ${onYes ? 'YES' : 'NO'}  (YES mid ${mid.toFixed(3)})`);
    } catch (e) { log(name, `error: ${String(e).slice(0, 120)}`); }
  }
}

const takers = (process.env.TAKER_KEYS ?? '').split(',').filter(Boolean) as Hex[];
log('sim', `market ${D.marketId.slice(0, 10)}… strike ${K} T ${new Date(T * 1000).toISOString()} fair=${env('SIM_FAIR', 'kraken')} takers=${takers.length}`);
await Promise.all([maker(), ...takers.map((k, i) => taker(k, i + 1))]);
