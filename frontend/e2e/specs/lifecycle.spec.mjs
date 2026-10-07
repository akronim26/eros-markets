import { test, expect } from '@playwright/test';
import { decodeEventLog } from 'viem';
import { installWallet } from '../support/wallet.mjs';
import { actor, client, demo, engineAbi, token, tokenAbi, vault, vaultAbi, read, settleDemo, syncClock } from '../support/fixture.mjs';

let clockTimer;
test.afterEach(() => clearInterval(clockTimer));

test('owner lifecycle through the real terminal and canonical on-chain state', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const wallet = await installWallet(page);
  const otherPage = await page.context().newPage();
  const otherWallet = await installWallet(otherPage, 17);
  clockTimer = setInterval(() => { void Promise.all([syncClock(page), syncClock(otherPage)]).catch(e => errors.push(`Fixture clock: ${e.message}`)); }, 3000);
  const owner = actor(16).address;
  const account = () => read('account', [owner]);
  const balance = () => client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] });
  const free = () => client.readContract({ address: vault, abi: vaultAbi, functionName: 'freeAtoms', args: [owner] });
  await page.goto(`/m/${demo.engine}`);
  await expect(page.getByText(/LOCAL E2E FIXTURE/)).toBeVisible();
  const aside = page.getByRole('complementary', { name: 'Trade', exact: true });
  const funds = aside.getByRole('region', { name: 'Account', exact: true });
  const ticket = aside.getByRole('region', { name: 'Order ticket', exact: true });
  const submitOrder = () => ticket.getByRole('button', { name: /^(Buy|Sell) YES/ }).and(ticket.locator('button:not([aria-pressed])'));
  async function confirmOrder() {
    const count = wallet.receipts.length;
    await expect(submitOrder()).toBeEnabled(); await submitOrder().click();
    await expect.poll(() => wallet.receipts.length).toBe(count + 1);
    await expect(ticket.getByRole('link', { name: 'View confirmation →', exact: true })).toHaveAttribute('href', `/thank-you?tx=${wallet.receipts.at(-1).hash}`);
  }
  async function order(side, price, size, kind = 'LIMIT') {
    await ticket.getByRole('group', { name: 'Side', exact: true }).getByRole('button', { name: side === 'buy' ? 'Buy YES' : 'Sell YES' }).click();
    await ticket.getByRole('radio', { name: new RegExp(`^${kind}$`, 'i') }).click();
    await ticket.getByLabel(/Price \(probability\)/).fill(price);
    await ticket.getByLabel(/Size \(claims\)/).fill(size);
    await confirmOrder();
    await expect(ticket.getByRole('status').filter({ hasText: /Resting|Filled|resting|filled/ })).toBeVisible();
  }
  await test.step('connect disposable wallet, validate form, reject faucet then retry', async () => {
    await page.locator('header').getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(page.locator('header').getByRole('button', { name: `Manage wallet ${owner}` })).toBeVisible();
    await expect(funds.getByRole('button', { name: 'Get 1,000 test tokens' })).toBeEnabled();
    wallet.rejectNext(); await funds.getByRole('button', { name: 'Get 1,000 test tokens' }).click();
    await expect(funds.getByRole('alert')).toContainText(/reject|denied/i); expect(await balance()).toBe(0n);
    await funds.getByRole('button', { name: 'Get 1,000 test tokens' }).click();
    await expect(funds.getByRole('status').filter({ hasText: /confirmed/i })).toBeVisible();
    expect(await balance()).toBe(1_000_000_000n);
    await funds.getByLabel(/Amount/).fill('1001'); await funds.getByLabel(/Amount/).blur();
    await expect(funds.getByRole('button', { name: /insufficient|exceeds|available/i })).toBeDisabled();
  });
  await test.step('account change interrupts approval/deposit/allocation, then exact owner resumes', async () => {
    await funds.getByLabel(/Amount/).fill('100'); wallet.switchAfterNext();
    const count = wallet.receipts.length;
    await funds.getByRole('button', { name: 'Fund collateral', exact: true }).click();
    await expect(page.locator('header').getByRole('button', { name: `Manage wallet ${actor(17).address}` })).toBeVisible();
    await expect(funds.getByLabel(/Amount/)).toHaveValue('');
    const approval = await client.waitForTransactionReceipt({ hash: wallet.receipts.at(-1).hash });
    await expect.poll(async () => (await client.getBlock({ blockTag: 'finalized' })).number, { timeout: 30_000 }).toBeGreaterThanOrEqual(approval.blockNumber + 2n);
    expect(wallet.receipts.length - count).toBe(1); expect(await free()).toBe(0n);
    expect((await account()).value.cashQ).toBe(0n);
    await wallet.select(16);
    await expect(page.locator('header').getByRole('button', { name: `Manage wallet ${owner}` })).toBeVisible();
    await funds.getByLabel(/Amount/).fill('100');
    await funds.getByRole('button', { name: 'Fund collateral', exact: true }).click();
    await expect(funds.getByRole('status').filter({ hasText: /fund market confirmed/i })).toBeVisible();
    expect(await balance()).toBe(900_000_000n); expect(await free()).toBe(0n);
    expect((await account()).value.cashQ).toBe(100n * 10n ** 24n);
  });
  await test.step('post, cancel one, cancel all; resting orders do not appear as fills', async () => {
    await order('buy', '0.480', '2', 'POST ONLY');
    expect((await account()).value.lots).toBe(0n);
    await page.getByRole('tab', { name: 'Open orders', exact: true }).click();
    const orders = page.getByRole('region', { name: 'Open orders', exact: true });
    await expect(orders.getByRole('button', { name: /^Cancel order / })).toHaveCount(1);
    await orders.getByRole('button', { name: /^Cancel order / }).click();
    await expect(orders.getByRole('status').filter({ hasText: /confirmed/i })).toBeVisible();
    await expect(orders.getByRole('button', { name: /^Cancel order / })).toHaveCount(0);
    await order('buy', '0.480', '2', 'POST ONLY');
    await order('buy', '0.481', '2', 'POST ONLY');
    await expect(orders.getByRole('button', { name: /^Cancel order / })).toHaveCount(2);
    await orders.getByRole('button', { name: 'Cancel all', exact: true }).click();
    await expect(orders.getByRole('status').filter({ hasText: /cancel all orders confirmed/i })).toBeVisible();
    await expect(orders.getByRole('button', { name: /^Cancel order / })).toHaveCount(0);
  });
  await test.step('wrong network disables collateral writes', async () => {
    const count = wallet.receipts.length;
    await funds.getByLabel(/Amount/).fill('1'); await wallet.wrongChain();
    await expect(funds.getByRole('button', { name: 'Switch to Monad testnet', exact: true })).toBeDisabled();
    expect(wallet.receipts.length).toBe(count); await wallet.correctChain();
    await expect(funds.getByRole('button', { name: 'Fund collateral', exact: true })).toBeEnabled();
  });
  await test.step('fill against real book liquidity and verify receipt and position', async () => {
    const before = wallet.receipts.length;
    await order('buy', '0.510', '0.500', 'IOC');
    expect((await account()).value.lots).toBe(500n);
    const receipt = await client.getTransactionReceipt({ hash: wallet.receipts.at(-1).hash });
    const events = receipt.logs.filter(l => l.address.toLowerCase() === demo.engine.toLowerCase()).flatMap(l => {
      try { return [decodeEventLog({ abi: engineAbi, data: l.data, topics: l.topics })]; } catch { return []; }
    });
    expect(events.some(e => /Fill/.test(e.eventName))).toBe(true); expect(wallet.receipts.length).toBe(before + 1);
  });
  await test.step('close position with the reduce-only IOC prepared by the UI', async () => {
    await page.getByRole('tab', { name: 'Position', exact: true }).click();
    await page.getByRole('button', { name: 'Close position', exact: true }).click();
    await expect(ticket.getByRole('checkbox', { name: /Reduce only/ })).toBeChecked();
    await expect(ticket.getByRole('radio', { name: 'IOC', exact: true })).toBeChecked();
    await confirmOrder();
    await expect(ticket.getByRole('status').filter({ hasText: /Filled/i })).toBeVisible();
    expect((await account()).value.lots).toBe(0n);
    await ticket.getByRole('checkbox', { name: /Reduce only/ }).uncheck();
  });
  await test.step('independent browser owner funds and provides a fresh matching order', async () => {
    await syncClock(otherPage); await otherPage.goto(`/m/${demo.engine}`);
    await otherPage.locator('header').getByRole('button', { name: 'Log in', exact: true }).click();
    const otherAside = otherPage.getByRole('complementary', { name: 'Trade', exact: true });
    const otherFunds = otherAside.getByRole('region', { name: 'Account', exact: true });
    const otherTicket = otherAside.getByRole('region', { name: 'Order ticket', exact: true });
    await otherFunds.getByRole('button', { name: 'Get 1,000 test tokens', exact: true }).click();
    await expect(otherFunds.getByRole('status').filter({ hasText: /confirmed/i })).toBeVisible();
    await otherFunds.getByLabel(/Amount/).fill('100');
    await otherFunds.getByRole('button', { name: 'Fund collateral', exact: true }).click();
    await expect(otherFunds.getByRole('status').filter({ hasText: /fund market confirmed/i })).toBeVisible();
    await otherTicket.getByRole('group', { name: 'Side', exact: true }).getByRole('button', { name: 'Sell YES' }).click();
    await otherTicket.getByRole('radio', { name: /^Post only$/i }).click();
    await otherTicket.getByLabel(/Price \(probability\)/).fill('0.500');
    await otherTicket.getByLabel(/Size \(claims\)/).fill('2');
    await otherTicket.getByRole('button', { name: /^Sell YES/ }).and(otherTicket.locator('button:not([aria-pressed])')).click();
    await expect(otherTicket.getByRole('status').filter({ hasText: /resting/i })).toBeVisible();
    await order('buy', '0.500', '2', 'IOC');
    expect((await account()).value.lots).toBe(2000n);
    expect((await read('account', [actor(17).address])).value.lots).toBe(-2000n);
  });
  await test.step('release excess collateral and withdraw to selected wallet', async () => {
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.getByText('Historical data is not connected yet.', { exact: false })).toBeVisible();
    await funds.getByRole('button', { name: 'Release', exact: true }).click();
    await funds.getByLabel(/Amount/).fill('10');
    await funds.getByRole('button', { name: 'Release collateral', exact: true }).click();
    await expect(funds.getByRole('status').filter({ hasText: /release confirmed/i })).toBeVisible(); expect(await free()).toBe(10_000_000n);
    await funds.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await funds.getByLabel(/Amount/).fill('10');
    await funds.getByRole('button', { name: 'Withdraw collateral', exact: true }).click();
    await expect(funds.getByRole('status').filter({ hasText: /withdraw confirmed/i })).toBeVisible();
    expect(await free()).toBe(0n); expect(await balance()).toBe(910_000_000n);
  });
  await test.step('oracle finality and bounded preparation unlock exact owner claim', async () => {
    await expect(funds.getByRole('button', { name: /^Claim / })).toHaveCount(0);
    await settleDemo(); await syncClock(page); await page.reload();
    await page.locator('header').getByRole('button', { name: 'Log in', exact: true }).click();
    const claim = await read('claimableAtoms', [owner]);
    expect(claim).toBeGreaterThan(0n);
    const walletBeforeClaim = await balance();
    const freeBeforeClaim = await free();
    await funds.getByRole('button', { name: /^Claim / }).click();
    await expect(funds.getByRole('status').filter({ hasText: /claim settlement confirmed/i })).toBeVisible();
    // Settlement pays the owner's wallet directly; it does not create a free
    // vault balance requiring a second withdrawal.
    expect(await free()).toBe(freeBeforeClaim);
    expect(await balance()).toBe(walletBeforeClaim + claim);
    await expect(funds.getByText('Settlement claimed.')).toBeVisible();
    await expect(funds.getByRole('button', { name: /^Claim / })).toHaveCount(0);
  });
  expect(errors).toEqual([]);
  await testInfo.attach('wallet-transactions', { body: JSON.stringify(wallet.receipts, null, 2), contentType: 'application/json' });
  await testInfo.attach('counterparty-transactions', { body: JSON.stringify(otherWallet.receipts, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('settled.png'), fullPage: true });
});
