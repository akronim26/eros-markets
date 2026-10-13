/** Shared chain access for the native spot market services (NM-S07..S09): one Monad testnet client,
 *  a +30% gas-margin sender, the Kuru book / margin-account ABIs and the deployment record. */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined || v === '') throw new Error(`MISSING_${k}`); return v; };
export const log = (who: string, msg: string) => console.log(`${new Date().toISOString()} ${who.padEnd(9)} ${msg}`);
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const nowSecs = () => Math.floor(Date.now() / 1000);

export const MARGIN = getAddress(process.env.KURU_MARGIN ?? '0xd029C2D98ff85D8F64799017fE00a59B1159CE02');
export const BOOK = parseAbi([
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
export const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)']);
export const MA = parseAbi(['function deposit(address,address,uint256)', 'function withdraw(uint256,address)', 'function getBalance(address,address) view returns (uint256)']);
export const VAULT = parseAbi([
  'function split(uint256,address)', 'function merge(uint256,address)', 'function redeem(uint256,uint256,address) returns (uint256)',
  'function syncResolution() returns (uint256)', 'function issuanceOpen() view returns (bool)', 'function resolved() view returns (bool)',
  'function payoutYesWad() view returns (uint256)', 'function engine() view returns (address)',
]);

/** DeployNativeMarket output (`D`): vault, tokens, books, schedule. */
export const D = JSON.parse(readFileSync(env('D'), 'utf8'));
export const C = getAddress(D.collateral), YES = getAddress(D.yesToken), NO = getAddress(D.noToken);
export const YB = getAddress(D.yesBook), NB = getAddress(D.noBook), V = getAddress(D.outcomeVault);
export const T = Number(D.scheduledT), MARKET_ID = D.marketId as Hex;

const RPC = env('RPC');
const chain = defineChain({ id: 10143, name: 'monad-testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 20_000, retryCount: 2 }) });

export function wallet(key: Hex) {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ chain, account, transport: http(RPC, { timeout: 20_000 }) });
  // Estimate, then send with +30% gas (Monad charges the limit; a stale exact estimate can run out of gas).
  async function send(address: Address, abi: any, functionName: string, args: readonly unknown[]) {
    const gas = await pub.estimateContractGas({ address, abi, functionName, args, account } as any);
    const hash = await w.writeContract({ address, abi, functionName, args, gas: gas * 13n / 10n } as any);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`REVERTED ${functionName} ${hash}`);
    return r;
  }
  return { me: account.address, send };
}

export const read = (address: Address, abi: any, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as any) as Promise<any>;
export const balance = (token: Address, who: Address) => read(token, ERC20, 'balanceOf', [who]) as Promise<bigint>;
export const margin = (who: Address, token: Address) => read(MARGIN, MA, 'getBalance', [who, token]) as Promise<bigint>;

/** Best bid/ask of a book as ticks (1..999), or null for an empty side. Kuru reports 1e18-scaled prices. */
export async function topOfBook(book: Address): Promise<{ bid: number | null; ask: number | null }> {
  const [b, a] = await read(book, BOOK, 'bestBidAsk') as [bigint, bigint];
  return { bid: b > 0n && b < 10n ** 30n ? Number(b / 10n ** 15n) : null, ask: a > 0n && a < 10n ** 30n ? Number(a / 10n ** 15n) : null };
}

/** Order ids created for `me` in a receipt. */
export function createdOrders(receipt: { logs: any[] }, me: Address): bigint[] {
  const ids: bigint[] = [];
  for (const l of receipt.logs) {
    try { const e = decodeEventLog({ abi: BOOK, ...l } as any) as any; if (e.eventName === 'OrderCreated' && getAddress(e.args.owner) === me) ids.push(BigInt(e.args.orderId)); } catch { /* other event */ }
  }
  return ids;
}

/** Ids of `me`'s still-open orders among the most recent `scan` ids of a book. */
export async function openOrders(book: Address, me: Address, scan = 400n): Promise<bigint[]> {
  const counter = BigInt(await read(book, BOOK, 's_orderIdCounter'));
  const lo = counter > scan ? counter - scan : 1n, open: bigint[] = [];
  for (let id = counter; id >= lo; id -= 1n) {
    const o = await read(book, BOOK, 's_orders', [Number(id)]);
    if (getAddress(o[0]) === me && BigInt(o[1]) > 0n) open.push(id);
  }
  return open;
}

/** Small durable JSON state (atomic replace). */
export function loadState<S>(file: string, initial: S): S { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : initial; }
export function saveState(file: string, s: unknown) { writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2) + '\n'); renameSync(`${file}.tmp`, file); }

/** After resolution: cancel nothing here, just pull Kuru margin balances back and redeem everything. */
export async function settleWallet(w: ReturnType<typeof wallet>, who: string) {
  if (!(await read(V, VAULT, 'resolved'))) {
    try { await w.send(V, VAULT, 'syncResolution', []); } catch { log(who, 'not resolved yet; nothing to redeem'); return; }
  }
  for (const t of [YES, NO, C]) { const m = await margin(w.me, t); if (m > 0n) await w.send(MARGIN, MA, 'withdraw', [m, t]); }
  const y = await balance(YES, w.me), n = await balance(NO, w.me);
  if (y > 0n || n > 0n) await w.send(V, VAULT, 'redeem', [y, n, w.me]);
  log(who, `settled: redeemed ${Number(y) / 1e6} YES + ${Number(n) / 1e6} NO; wallet tUSDC ${Number(await balance(C, w.me)) / 1e6}`);
}
