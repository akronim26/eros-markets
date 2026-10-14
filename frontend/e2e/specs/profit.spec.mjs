import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { decodeEventLog, parseUnits } from 'viem';
import { client, demo, engineAbi, read, runtime, syncClock, token, tokenAbi, vault, vaultAbi } from '../support/fixture.mjs';
import { installWallet } from '../support/wallet.mjs';

// The fixture publisher reads its synthetic book mid from this file (absent = 0.50).
const midControl = path.join(process.env.EROS_E2E_STACK, 'pricefeed', 'index-mid');
const publisherReport = path.join(process.env.EROS_E2E_STACK, 'publisher-live.json');
const SIZE = '20';

test('a long closed after the index rises releases its profit to the wallet through the terminal', async ({ page, browser }, testInfo) => {
  test.skip(runtime.scenario !== 'leveraged', 'Needs the leveraged fixture with normal pricing.');
  test.setTimeout(600_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const otherContext = await browser.newContext({ baseURL: process.env.EROS_E2E_BASE_URL, viewport: { width: 1440, height: 1000 } });
  const otherPage = await otherContext.newPage();
  otherPage.on('pageerror', error => errors.push(error.message));
  const trader = await installWallet(page, 22);
  const counterparty = await installWallet(otherPage, 23);
  const timer = setInterval(() => {
    void Promise.all([syncClock(page), syncClock(otherPage)]).catch(e => errors.push(e.message));
  }, 3000);
  const ticket = p => p.getByRole('complementary', { name: 'Trade', exact: true }).getByRole('region', { name: 'Order ticket', exact: true });
  const funds = p => p.getByRole('main', { name: 'Trading terminal' }).getByRole('region', { name: 'Account', exact: true });
  const orderButton = p => ticket(p).getByRole('button', { name: /^((Long|Short) YES|Close position$)/ }).and(ticket(p).locator('button:not([aria-pressed])'));
  const balance = owner => client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] });
  const free = owner => client.readContract({ address: vault, abi: vaultAbi, functionName: 'freeAtoms', args: [owner] });
  const account = owner => read('account', [owner]);
  // The INDEX is a 300 s TWAP. Rather than wait five minutes, step the local chain clock in 10 s
  // sample steps; the publisher observes the new mid at each step, so the window fills in ~31 steps.
  async function moveIndex(mid) {
    if (mid === '0.50') fs.rmSync(midControl, { force: true });
    else fs.writeFileSync(midControl, `${mid}\n`);
    const target = parseUnits(mid, 18);
    const deadline = Date.now() + 60_000;
    while ((await read('marketRiskView')).indexWad !== target) {
      expect(Date.now(), `INDEX did not reach ${mid} within a minute`).toBeLessThan(deadline);
      const next = (await client.getBlock()).timestamp + 10n;
      await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(next)] });
      await client.request({ method: 'evm_mine', params: [] });
      await expect.poll(() => published(), { timeout: 10_000, intervals: [100] }).toBeGreaterThanOrEqual(next);
    }
    // Clock steps may cross an hourly epoch end; trade only once upkeep has finished any rollover.
    await expect.poll(async () => { const v = await read('marketRiskView'); return v.accountingState === 0 && v.pendingWork === 0; },
      { timeout: 120_000, intervals: [1000] }).toBe(true);
  }
  function published() {
    try { return BigInt(JSON.parse(fs.readFileSync(publisherReport, 'utf8')).lastPublishedAt ?? 0) / 1000n; } catch { return 0n; }
  }
  async function manageCollateral(p) {
    const disclosure = funds(p).locator('details').filter({ hasText: 'Manage collateral' });
    await expect(disclosure).toBeVisible();
    if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
  }
  async function fund(p, wallet, amount) {
    expect(await balance(wallet.address), 'fresh browser actor').toBe(0n);
    expect((await account(wallet.address)).value.cashQ, 'fresh browser actor').toBe(0n);
    await p.goto(`/m/${demo.engine}`);
    const notice = p.getByRole('button', { name: 'Got it', exact: true });
    await expect(notice).toBeVisible();
    await notice.click();
    await p.locator('header').getByRole('button', { name: 'Log in', exact: true }).click();
    await manageCollateral(p);
    const faucet = funds(p).getByRole('button', { name: 'Get 1,000 test tokens' });
    await expect(faucet).toBeEnabled({ timeout: 45_000 });
    await faucet.click();
    await expect(funds(p).getByRole('status').filter({ hasText: /confirmed/i })).toBeVisible();
    await funds(p).getByLabel(/Amount/).fill(amount);
    await funds(p).getByRole('button', { name: 'Fund collateral', exact: true }).click();
    await expect(funds(p).getByRole('status').filter({ hasText: /fund market confirmed/i })).toBeVisible();
  }
  async function submit(p, wallet) {
    const before = wallet.receipts.length;
    await expect(orderButton(p)).toBeEnabled();
    await orderButton(p).click();
    await expect.poll(() => wallet.receipts.length).toBe(before + 1);
    await expect(ticket(p).getByRole('link', { name: 'View confirmation →', exact: true })).toHaveAttribute('href', `/thank-you?tx=${wallet.receipts.at(-1).hash}`);
    const receipt = await client.getTransactionReceipt({ hash: wallet.receipts.at(-1).hash });
    expect(receipt.status).toBe('success');
    return receipt;
  }
  async function order(p, wallet, side, kind, price, size) {
    await ticket(p).getByRole('group', { name: 'Trade direction and outcome', exact: true }).getByRole('button', { name: side, exact: true }).click();
    await ticket(p).getByRole('radio', { name: new RegExp(`^${kind}$`, 'i') }).click();
    await ticket(p).getByLabel(/^YES price\b/).fill(price);
    await ticket(p).getByLabel(/Size \(claims\)/).fill(size);
    return submit(p, wallet);
  }
  async function cancelAll(p) {
    await p.getByRole('tab', { name: 'Open orders', exact: true }).click();
    const orders = p.getByRole('region', { name: 'Open orders', exact: true });
    if (await orders.getByRole('button', { name: /^Cancel order / }).count() === 0) return;
    await orders.getByRole('button', { name: 'Cancel all', exact: true }).click();
    await expect(orders.getByRole('status').filter({ hasText: /cancel all orders confirmed/i })).toBeVisible();
    await expect(orders.getByRole('button', { name: /^Cancel order / })).toHaveCount(0);
  }
  // Trader's fills only, in USDC atoms: one lot pays 1000 atoms, so a lot at tick t costs t atoms.
  function fills(receipt, traderId) {
    return receipt.logs.filter(log => log.address.toLowerCase() === demo.engine.toLowerCase()).flatMap(log => {
      try { return [decodeEventLog({ abi: engineAbi, data: log.data, topics: log.topics })]; } catch { return []; }
    }).filter(event => event.eventName === 'Fill' && event.args.taker === traderId);
  }
  const notional = list => list.reduce((sum, fill) => sum + BigInt(fill.args.tick) * fill.args.size, 0n);
  const takerFees = list => list.reduce((sum, fill) => sum + fill.args.takerFeeQ, 0n) / 10n ** 18n;
  const [startBid, startAsk] = await read('bestBidAsk');
  try {
    await fund(page, trader, '100');
    await fund(otherPage, counterparty, '1000');
    const walletAfterFunding = await balance(trader.address);
    expect(walletAfterFunding).toBe(900_000_000n);

    await moveIndex('0.55');
    await order(otherPage, counterparty, 'Short YES', 'LIMIT', '0.550', SIZE);
    const open = await order(page, trader, 'Long YES', 'IOC', '0.550', SIZE);
    const traderId = await read('participantId', [trader.address]);
    const bought = fills(open, traderId);
    expect(bought.every(fill => fill.args.tick <= 550)).toBe(true);
    expect((await account(trader.address)).value.lots).toBe(parseUnits(SIZE, 3));

    await moveIndex('0.60');
    // The counterparty's 0.60 bid becomes the best bid; it first lifts any stale asks below it.
    await cancelAll(otherPage);
    await order(otherPage, counterparty, 'Long YES', 'LIMIT', '0.600', '400');
    expect((await read('bestBidAsk'))[0]).toBe(600);

    await page.getByRole('tab', { name: 'Position', exact: true }).click();
    await page.getByRole('button', { name: 'Close position', exact: true }).click();
    await expect(ticket(page).getByRole('checkbox', { name: /Reduce only/ })).toBeChecked();
    await expect(ticket(page).getByRole('radio', { name: 'IOC', exact: true })).toBeChecked();
    await expect(ticket(page).getByLabel(/^YES price\b/)).toHaveValue('0.600');
    // A full close also releases the market collateral and withdraws it to the wallet: no manual step.
    const before = trader.receipts.length;
    await expect(orderButton(page)).toBeEnabled();
    await orderButton(page).click();
    await expect(ticket(page).getByRole('status').filter({ hasText: /Position closed\. Funds returned to your wallet\./ })).toBeVisible();
    expect(trader.receipts.length, 'order, release and withdraw').toBe(before + 3);
    const [close, release, withdraw] = await Promise.all(trader.receipts.slice(before).map(r => client.getTransactionReceipt({ hash: r.hash })));
    for (const receipt of [close, release, withdraw]) expect(receipt.status).toBe('success');
    const sold = fills(close, traderId);
    expect(sold.every(fill => fill.args.tick === 600)).toBe(true);
    expect(sold.reduce((sum, fill) => sum + fill.args.size, 0n)).toBe(parseUnits(SIZE, 3));
    const flat = await account(trader.address);
    expect(flat.value.lots, 'position closed').toBe(0n);
    expect(flat.value.cashQ, 'market cash released').toBeLessThan(10n ** 18n);
    expect(await free(trader.address), 'vault balance withdrawn').toBe(0n);

    const walletGain = await balance(trader.address) - walletAfterFunding - 100_000_000n;
    const tradeGain = notional(sold) - notional(bought) - takerFees(bought) - takerFees(sold);
    expect(tradeGain, 'bought at or below 0.55, sold at 0.60').toBeGreaterThanOrEqual(parseUnits(SIZE, 3) * 50n);
    expect(walletGain, 'the profit reaches the wallet').toBeGreaterThan(0n);
    await testInfo.attach('profit', { contentType: 'application/json', body: JSON.stringify({
      open: open.transactionHash, close: close.transactionHash, boughtAtoms: notional(bought), soldAtoms: notional(sold),
      takerFeeAtoms: takerFees(bought) + takerFees(sold), tradeGainAtoms: tradeGain, walletGainAtoms: walletGain,
      fundingAndPremiumAtoms: walletGain - tradeGain, release: release.transactionHash, withdraw: withdraw.transactionHash,
      finalWallet: await balance(trader.address),
    }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) });

    // Restore the index and the touch the lifecycle test trades against.
    await cancelAll(otherPage);
    await moveIndex('0.50');
    if (startBid) await order(otherPage, counterparty, 'Long YES', 'POST ONLY', (startBid / 1000).toFixed(3), SIZE);
    if (startAsk) await order(otherPage, counterparty, 'Short YES', 'POST ONLY', (startAsk / 1000).toFixed(3), SIZE);
    expect(await read('bestBidAsk')).toEqual([startBid, startAsk]);
    expect(errors).toEqual([]);
  } finally {
    clearInterval(timer);
    fs.rmSync(midControl, { force: true });
    await otherContext.close();
  }
});
