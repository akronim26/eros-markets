import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWalletClient, http, parseEther, toHex } from 'viem';
import { anvil } from 'viem/chains';
import { client, actor, demo, token, vault, guard, syncClock, runtime } from './fixture.mjs';

/** EIP-1193 transport for loopback Anvil. Keys never enter the page or its traces. */
export async function installWallet(page, index = 16) {
  assert.ok([16, 17].includes(index));
  let selected = actor(index).address, rejectNext = false, switchNext = false;
  const receipts = [];
  await guard();
  for (const i of [16, 17]) await client.request({ method: 'anvil_setBalance', params: [actor(i).address, toHex(parseEther('10'))] });
  await page.exposeBinding('__erosFixtureRequest', async (_source, request) => {
    try {
      const { method, params = [] } = request;
      if (method === 'eth_chainId') return { result: '0x7a69' };
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return { result: [selected] };
      if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return { result: [{ parentCapability: 'eth_accounts' }] };
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
        assert.equal(Number(params[0].chainId), 31337); return { result: null };
      }
      if (method === 'eth_sendTransaction') {
        await guard();
        const tx = params[0];
        assert.equal(tx.from.toLowerCase(), selected.toLowerCase());
        assert.ok([demo.engine, token, vault].some(a => a.toLowerCase() === tx.to.toLowerCase()), 'Unrecognized transaction target');
        assert.equal(BigInt(tx.value || '0x0'), 0n, 'Native transfers are outside browser fixture scope');
        assert.ok(BigInt(tx.gas) <= 30_000_000n, 'Excessive transaction gas');
        if (rejectNext) { rejectNext = false; return { error: { code: 4001, message: 'User rejected the request.' } }; }
        // Send the already selected approval, then switch accounts before dependent deposit/allocation.
        const account = actor(selected === actor(16).address ? 16 : 17);
        const signer = createWalletClient({ chain: anvil, transport: http(runtime.rpcUrl), account });
        const hash = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n, gas: BigInt(tx.gas),
          ...(tx.gasPrice ? { gasPrice: BigInt(tx.gasPrice) } : {}),
          ...(tx.maxFeePerGas ? { maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas || '0x0') } : {}) });
        receipts.push({ hash, from: tx.from, to: tx.to, data: tx.data });
        fs.appendFileSync(path.join(process.env.EROS_E2E_DIRECTORY, 'browser-transactions.jsonl'), JSON.stringify(receipts.at(-1)) + '\n');
        if (switchNext) {
          switchNext = false; selected = actor(selected === actor(16).address ? 17 : 16).address;
          await page.evaluate(address => window.__erosTestWallet.emit('accountsChanged', [address]), selected);
        }
        return { result: hash };
      }
      const readMethods = new Set(['eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_call', 'eth_estimateGas',
        'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_blockNumber', 'eth_getBlockByNumber',
        'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs']);
      assert.ok(readMethods.has(method), `Unsupported wallet method: ${method}`);
      return { result: await client.request({ method, params }) };
    } catch (error) { return { error: { code: error.code || -32603, message: error.shortMessage || error.message } }; }
  });
  await page.addInitScript(() => {
    const listeners = new Map();
    const provider = { isMetaMask: true,
      request: async request => { const response = await window.__erosFixtureRequest(request); if (response.error) throw Object.assign(new Error(response.error.message), response.error); return response.result; },
      on: (event, listener) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(listener); return provider; },
      removeListener: (event, listener) => { listeners.get(event)?.delete(listener); return provider; },
    };
    window.ethereum = provider;
    window.__erosTestWallet = { emit: (event, value) => listeners.get(event)?.forEach(listener => listener(value)) };
  });
  await syncClock(page);
  return {
    get address() { return selected; }, receipts,
    rejectNext: () => { rejectNext = true; }, switchAfterNext: () => { switchNext = true; },
    select: async next => { assert.ok([16, 17].includes(next)); selected = actor(next).address; await page.evaluate(address => window.__erosTestWallet.emit('accountsChanged', [address]), selected); },
    wrongChain: async () => page.evaluate(() => window.__erosTestWallet.emit('chainChanged', '0x1')),
    correctChain: async () => page.evaluate(() => window.__erosTestWallet.emit('chainChanged', '0x7a69')),
  };
}
