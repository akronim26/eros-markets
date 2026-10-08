import { test, expect } from '@playwright/test';
import { demo, runtime, syncClock } from '../support/fixture.mjs';
import { installWallet } from '../support/wallet.mjs';

async function dismissNotice(page) {
  const dismiss = page.getByRole('button', { name: 'Got it', exact: true });
  // A new context has no acknowledgement. This effect-rendered notice also
  // ensures React has hydrated before testing interactive controls.
  await expect(dismiss).toBeVisible();
  await dismiss.click();
}

async function theme(page, name) {
  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  if (name !== 'System') await expect(page.locator('html')).toHaveAttribute('data-theme', name.toLowerCase());
}

test('public routes, themes and responsive terminal remain usable', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await syncClock(page);
  await page.goto('/markets');
  await dismissNotice(page);
  for (const name of ['Light', 'Dark']) {
    await theme(page, name);
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['/markets', `/m/${demo.engine}`]) {
        await page.goto(route);
        await expect(page.locator('main')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', name.toLowerCase());
        if (route.startsWith('/m/')) {
          await expect(page.getByRole('heading', { name: 'Local E2E demo event', exact: true })).toBeVisible();
          await expect(page.getByRole('link', { name: 'Back to all markets' })).toBeVisible();
          await expect(page.getByRole('complementary', { name: 'Trade', exact: true })).toHaveCount(1);
          for (const tab of ['Position', 'Open orders', 'History', 'Protection']) {
            await page.getByRole('tab', { name: tab, exact: true }).click();
            await expect(page.getByRole('tabpanel')).toBeVisible();
          }
          for (const detail of ['Market info', 'Risk', 'Liquidity', 'Operations', 'Resolution']) {
            await page.getByRole('combobox', { name: 'More market details', exact: true }).selectOption({ label: detail });
            await expect(page.getByRole('tabpanel')).toBeVisible();
          }
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} ${width} ${route} must not overflow`).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath(`terminal-${name.toLowerCase()}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const route of ['/', '/portfolio', '/resolution', '/privacy', '/terms', '/thank-you', '/unknown-audit-page']) {
    const response = await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    expect(response.status()).toBe(route === '/unknown-audit-page' ? 404 : 200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await expect(page.getByRole('heading', { name: 'Off the charts.' })).toBeVisible();
  await page.getByRole('link', { name: 'Explore markets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Markets', exact: true })).toBeVisible();
  await theme(page, 'System');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors).toEqual([]);
});

test('market search, navigation and browser storage controls', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/markets');
  await dismissNotice(page);
  const search = page.getByRole('searchbox', { name: 'Search markets' });
  await search.fill('demo');
  await expect(page).toHaveURL(/\?q=demo$/);
  await expect(page.getByRole('link', { name: 'Open Local E2E demo event trading terminal' }).filter({ visible: true })).toHaveCount(1);
  await search.fill('there-is-no-such-event');
  await expect(page.getByRole('heading', { name: 'No matching markets' })).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await search.fill('demo');
  await page.reload();
  await expect(search).toHaveValue('demo');
  await page.getByRole('link', { name: 'Open Local E2E demo event trading terminal' }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { name: 'Local E2E demo event' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to all markets' }).click();
  await expect(page.getByRole('heading', { name: 'Markets', exact: true })).toBeVisible();
  const noticeButton = page.getByRole('button', { name: 'Cookies & storage' });
  await noticeButton.click();
  await expect(page.getByRole('complementary', { name: 'A note on cookies & storage' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(noticeButton).toBeFocused();
  await page.goto('/thank-you?tx=not-a-transaction');
  await expect(page.getByRole('region', { name: 'Visit summary' }).getByRole('alert')).toContainText('transaction reference is invalid');
  expect(errors).toEqual([]);
});

test('RPC outage retains a labeled snapshot, blocks writes and recovers', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const wallet = await installWallet(page);
  await syncClock(page);
  await page.goto(`/m/${demo.engine}`);
  await dismissNotice(page);
  await expect(page.getByRole('heading', { name: 'Local E2E demo event' })).toBeVisible();
  await page.locator('header').getByRole('button', { name: 'Log in', exact: true }).click();
  const funds = page.getByRole('complementary', { name: 'Trade', exact: true }).getByRole('region', { name: 'Account', exact: true });
  const collateral = funds.locator('details').filter({ hasText: 'Manage collateral' });
  await expect(collateral).toBeVisible();
  if (await collateral.getAttribute('open') === null) await collateral.locator('summary').click();
  const faucet = funds.getByRole('button', { name: 'Get 1,000 test tokens' });
  await expect(faucet).toBeEnabled();
  const rpc = new URL(runtime.rpcUrl);
  const matchesRpc = url => url.hostname === rpc.hostname && url.port === rpc.port;
  await page.route(matchesRpc, route => route.abort('connectionfailed'));
  const failure = page.getByRole('alert').filter({ hasText: 'Connection interrupted' });
  await expect(failure).toBeVisible({ timeout: 60_000 });
  await expect(faucet).toBeDisabled();
  expect(wallet.receipts).toEqual([]);
  await page.unroute(matchesRpc);
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(faucet).toBeEnabled();
  expect(wallet.receipts).toEqual([]);
  expect(errors).toEqual([]);
});

test('storage restrictions and reduced motion preserve public navigation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
      configurable: true, get() { throw new DOMException('Storage blocked for audit', 'SecurityError'); },
    });
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await dismissNotice(page);
  await theme(page, 'Light');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-transition');
  await page.locator('header').getByRole('link', { name: 'Markets', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search markets' })).toBeVisible();
  expect(errors).toEqual([]);
});
