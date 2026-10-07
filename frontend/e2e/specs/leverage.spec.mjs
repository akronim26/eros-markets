import { test, expect } from '@playwright/test';
import { decodeEventLog, parseUnits } from 'viem';
import { actor, client, demo, engineAbi, read, runtime, syncClock, token, tokenAbi, vault, vaultAbi } from '../support/fixture.mjs';
import { installWallet } from '../support/wallet.mjs';

test('fivefold leveraged order uses the actual terminal and fills on the local engine', async ({ page, browser }, testInfo) => {
  test.skip(runtime.scenario !== 'leveraged', 'Explicit fully-backed fixture has no leveraged admission.');
  test.setTimeout(360_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const makerContext = await browser.newContext({ baseURL: process.env.EROS_E2E_BASE_URL, viewport: { width: 1440, height: 1000 } });
  const makerPage = await makerContext.newPage();
  makerPage.on('pageerror', error => errors.push(error.message));
  const buyer = await installWallet(page, 20);
  const maker = await installWallet(makerPage, 21);
  const timer = setInterval(() => {
    void Promise.all([syncClock(page), syncClock(makerPage)]).catch(e => errors.push(e.message));
  }, 3000);
  const panel = p => p.getByRole('complementary', { name: 'Trade', exact: true });
  const ticket = p => panel(p).getByRole('region', { name: 'Order ticket', exact: true });
  const orderButton = p => ticket(p).getByRole('button', { name: /^(Buy|Sell) YES/ }).and(ticket(p).locator('button:not([aria-pressed])'));
  async function fund(p, wallet, amount) {
    const [balance, free, account] = await Promise.all([
      client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [wallet.address] }),
      client.readContract({ address: vault, abi: vaultAbi, functionName: 'freeAtoms', args: [wallet.address] }),
      read('account', [wallet.address]),
    ]);
    expect(balance, 'Browser actor must have no pre-existing test tokens').toBe(0n);
    expect(free, 'Browser actor must have no pre-existing free vault balance').toBe(0n);
    expect(account.value.cashQ, 'Browser actor must have no pre-existing market collateral').toBe(0n);
    expect(account.value.lots, 'Browser actor must start with no market position').toBe(0n);
    await p.goto(`/m/${demo.engine}`);
    const notice = p.getByRole('button', { name: 'Got it', exact: true });
    await expect(notice).toBeVisible();
    await notice.click();
    await p.locator('header').getByRole('button', { name: 'Log in', exact: true }).click();
    const funds = panel(p).getByRole('region', { name: 'Account', exact: true });
    const faucet = funds.getByRole('button', { name: 'Get 1,000 test tokens' });
    await expect(faucet).toBeVisible({ timeout: 45_000 });
    await expect(faucet).toBeEnabled({ timeout: 45_000 });
    await faucet.click({ timeout: 45_000 });
    await expect(funds.getByRole('status').filter({ hasText: /confirmed/i })).toBeVisible();
    await funds.getByLabel(/Amount/).fill(amount);
    await funds.getByRole('button', { name: 'Fund collateral', exact: true }).click();
    await expect(funds.getByRole('status').filter({ hasText: /fund market confirmed/i })).toBeVisible();
  }
  async function submit(p, wallet) {
    const before = wallet.receipts.length;
    await expect(orderButton(p)).toBeEnabled();
    await orderButton(p).click();
    await expect.poll(() => wallet.receipts.length).toBe(before + 1);
    await expect(ticket(p).getByRole('link', { name: 'View confirmation →', exact: true })).toHaveAttribute('href', `/thank-you?tx=${wallet.receipts.at(-1).hash}`);
    return client.getTransactionReceipt({ hash: wallet.receipts.at(-1).hash });
  }
  function events(receipt) {
    return receipt.logs.filter(log => log.address.toLowerCase() === demo.engine.toLowerCase()).flatMap(log => {
      try { return [decodeEventLog({ abi: engineAbi, data: log.data, topics: log.topics })]; } catch { return []; }
    });
  }
  try {
    await fund(page, buyer, '10');
    await fund(makerPage, maker, '1000');
    await expect.poll(async () => (await read('marketRiskView')).markAvailable).toBe(true);
    expect(await read('leverageCaps')).toEqual([5n, 5n]);
    // Add funded depth at the existing quotes: a large fivefold IOC must not
    // mistake the fixture's one-claim touch for sufficient executable liquidity.
    // Keeping the touch unchanged also leaves the mark's book input unchanged.
    const [bestBid, bestAsk] = await read('bestBidAsk');
    expect(bestBid).toBeGreaterThan(0);
    expect(bestAsk).toBeGreaterThan(0);
    expect(bestAsk).toBeGreaterThan(bestBid);
    const makerLots = 150_000n;
    for (const [side, tick] of [['Buy YES', bestBid], ['Sell YES', bestAsk]]) {
      await ticket(makerPage).getByRole('group', { name: 'Side', exact: true }).getByRole('button', { name: side, exact: true }).click();
      await ticket(makerPage).getByRole('radio', { name: /^Post only$/i }).click();
      await ticket(makerPage).getByLabel(/Price \(probability\)/).fill((tick / 1000).toFixed(3));
      await ticket(makerPage).getByLabel(/Size \(claims\)/).fill('150');
      const placed = events(await submit(makerPage, maker));
      expect(placed.filter(event => event.eventName === 'Fill')).toHaveLength(0);
      expect(placed.find(event => event.eventName === 'OrderPlaced')?.args.size).toBe(makerLots);
      expect(await read('bestBidAsk')).toEqual([bestBid, bestAsk]);
    }
    expect((await read('account', [actor(21).address])).value.lots).toBe(0n);
    await ticket(page).getByLabel(/Price \(probability\)/).fill((bestAsk / 1000).toFixed(3));
    let previousSize = 0, chosenSize = '';
    for (const x of [1, 2, 3, 4, 5]) {
      const control = ticket(page).getByRole('group', { name: 'Target leverage' }).getByRole('button', { name: `${x}×`, exact: true });
      await expect(control).toBeEnabled();
      await control.click();
      chosenSize = await ticket(page).getByLabel(/Size \(claims\)/).inputValue();
      const size = Number(chosenSize);
      expect(size).toBeGreaterThan(previousSize);
      previousSize = size;
    }
    const requestedLots = parseUnits(chosenSize, 3);
    expect(requestedLots).toBeLessThan(makerLots);
    await ticket(page).getByRole('radio', { name: 'IOC', exact: true }).click();
    const receipt = await submit(page, buyer);
    expect(receipt.status).toBe('success');
    const fills = events(receipt).filter(event => event.eventName === 'Fill');
    expect(fills.reduce((sum, fill) => sum + fill.args.size, 0n)).toBe(requestedLots);
    const ownerId = await read('participantId', [actor(20).address]);
    const position = await client.readContract({ address: demo.engine, abi: engineAbi, functionName: 'previewAccount', args: [ownerId], blockNumber: receipt.blockNumber });
    expect(position.positionLots).toBe(requestedLots);
    expect(position.id.markAvailable).toBe(true);
    const leverageWad = requestedLots * 1000n * position.id.markWad * 10n ** 18n / position.markEquityQ;
    expect(leverageWad).toBeGreaterThanOrEqual(49n * 10n ** 17n);
    expect(leverageWad).toBeLessThanOrEqual(5n * 10n ** 18n);
    await testInfo.attach('local-leveraged-fill', { body: JSON.stringify({ hash: receipt.transactionHash, block: receipt.blockNumber, size: requestedLots, leverageWad }, (_, value) => typeof value === 'bigint' ? value.toString() : value), contentType: 'application/json' });
    await page.getByRole('tab', { name: 'Position', exact: true }).click();
    await page.getByRole('button', { name: 'Close position', exact: true }).click();
    const closeReceipt = await submit(page, buyer);
    expect(closeReceipt.status).toBe('success');
    expect(events(closeReceipt).filter(event => event.eventName === 'Fill').reduce((sum, fill) => sum + fill.args.size, 0n)).toBe(requestedLots);
    expect((await read('account', [actor(20).address])).value.lots).toBe(0n);
    expect((await read('account', [actor(21).address])).value.lots).toBe(0n);
    expect(await read('bestBidAsk')).toEqual([bestBid, bestAsk]);
    // Retain the remaining maker orders for the following lifecycle test.
    expect((await read('getLevel', [true, bestBid])).size).toBeGreaterThan(0n);
    expect((await read('getLevel', [false, bestAsk])).size).toBeGreaterThan(0n);
    expect(errors).toEqual([]);
  } finally {
    clearInterval(timer);
    await makerContext.close();
  }
});
