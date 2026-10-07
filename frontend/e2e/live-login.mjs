/** Real Privy checkpoint. No fixture provider, private key, stored auth export or signing bypass. */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createPublicClient, http, keccak256 } from 'viem';
import { monadTestnet } from 'viem/chains';
const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/src/config/public-manifest.json'), 'utf8'));
if (manifest.chainId !== 10143 || manifest.scope !== 'testnet-read-only') throw new Error('Verified testnet manifest required');
const baseURL = process.env.EROS_LIVE_BASE_URL || 'http://localhost:3100';
const url = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Use the local public frontend for this checkpoint');
const directory = path.join(root, 'tmp', `e2e-live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(directory, { recursive: true });
const report = { scope: 'public-testnet-real-wallet', status: 'preflight', chainId: 10143, market: manifest.markets[0].engine,
  authentication: 'pending-human', transactions: 'not-tested', history: 'not-tested', settlement: 'requires-resolved-event', startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
save();
let browser;
try {
  const rpc = createPublicClient({ chain: monadTestnet, transport: http('https://testnet-rpc.monad.xyz') });
  if (await rpc.getChainId() !== 10143) throw new Error('Wrong public RPC chain');
  if ((await rpc.getBlock({ blockNumber: BigInt(manifest.verifiedAt.blockNumber) })).hash !== manifest.verifiedAt.blockHash) throw new Error('Deployment anchor is no longer canonical');
  if (keccak256(await rpc.getCode({ address: report.market })) !== manifest.markets[0].codehash) throw new Error('Engine code mismatch');
  const cdp = process.env.EROS_LIVE_CDP;
  let context;
  if (cdp) {
    const endpoint = new URL(cdp);
    if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('Only a dedicated local CDP browser is allowed');
    browser = await chromium.connectOverCDP(cdp); context = browser.contexts()[0];
    const session = await browser.newBrowserCDPSession();
    const version = await session.send('Browser.getVersion');
    await session.detach();
    if (version.userAgent.includes('HeadlessChrome')) throw new Error('Human login requires a visible browser. Omit EROS_LIVE_CDP to open one.');
  } else {
    context = await chromium.launchPersistentContext(path.join(directory, 'private-browser-profile'), {
      channel: 'chrome', headless: false, viewport: { width: 1440, height: 1000 },
    });
  }
  const page = await context.newPage(); await page.goto(`${baseURL}/m/${report.market}`); await page.bringToFront();
  await page.evaluate(() => { document.title = 'EROS E2E CHECKPOINT — Visible Chrome'; });
  if (await page.getByText(/LOCAL E2E FIXTURE/).count()) throw new Error('Public checkpoint accidentally points at fixture build');
  const login = page.locator('header').getByRole('button', { name: 'Log in', exact: true });
  await page.locator('header').getByRole('button', { name: /^(Log in|Manage wallet 0x)/ }).waitFor({ state: 'visible', timeout: 60_000 });
  if (await login.isVisible()) await login.click();
  report.status = 'waiting-for-human-login'; save();
  console.log(JSON.stringify({ status: report.status, url: page.url(), report: path.join(directory, 'report.json'), instruction: 'Complete real Privy login in the opened browser. No secret should be pasted into chat.' }));
  const wallet = page.locator('header').getByRole('button', { name: /^Manage wallet 0x/ });
  await wallet.waitFor({ state: 'visible', timeout: 15 * 60_000 });
  const address = (await wallet.getAttribute('aria-label')).match(/0x[0-9a-fA-F]{40}/)[0];
  report.wallet = address; report.nativeBalance = (await rpc.getBalance({ address })).toString();
  await wallet.click();
  report.privyWalletOffered = await page.getByText('Privy wallet', { exact: true }).isVisible();
  report.authentication = 'passed'; report.status = 'login-passed-transactions-pending';
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify(report, null, 2));
  // Leave the authenticated window open for owner-confirmed transaction checks.
} catch (error) {
  report.status = report.status === 'waiting-for-human-login' ? 'human-login-pending' : 'failed';
  report.error = error.message; save(); console.error(JSON.stringify({ status: report.status, report: path.join(directory, 'report.json') }));
  process.exitCode = 1;
} finally {
  // Disconnect automation only; preserve the user's dedicated browser/session.
  if (browser) await browser.close();
}
