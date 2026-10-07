import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import * as viem from 'viem';
import { engineAbi } from '../src/abi/engine.ts';
import { PublicError, publicErrorMessage } from '../src/lib/public-error.ts';
import { apiError } from '../src/server/privy.ts';
import { validateIntent } from '../src/lib/delegated-intent.ts';
import { DelegatedAttemptStore, DelegatedDeliveryError, assertAttemptBinding, confirmDelegatedAttempt, delegatedCalldata, recoverDelegatedAttempt } from '../src/lib/delegated-attempt.ts';
import { finalizedOwnerReceipt, FinalizedOwnerRevert } from '../src/lib/finality.ts';

const require = createRequire(import.meta.url);
const owner = `0x${'1'.repeat(40)}`, engine = `0x${'2'.repeat(40)}`;
const body = nonce => ({ wallet: owner, engine, previewBlock: '100', clientNonce: nonce, action: 'placeOrder',
  place: { kind: 1, isBuy: true, reduceOnly: false, tick: 500, size: '1000', maxFills: 64, expiryBlock: 0 } });
const attempt = input => ({ version: 1, chainId: 10143, body: input, calldata: delegatedCalldata(input), connectorUid: 'selected-wallet', sessionVersion: 3, createdAt: 1000 });
function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
// Load actual production server/route code with only I/O dependencies replaced.
// No persistent DB, credentials, RPC or signing service is used.
function load(relative, dependencies) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith('node:')) return require(name);
    throw Error(`Unmocked dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}
function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE requests(id TEXT PRIMARY KEY,wallet TEXT,digest TEXT,status TEXT,hash TEXT,created INTEGER)');
  const state = { broadcasts: 0, policyChecks: 0, chainId: 10143, permission: true, signingError: false, block: 100n, gate: undefined };
  const server = load('../src/server/trade.ts', {
    viem, '@/lib/public-error': { PublicError, publicErrorMessage }, '@/abi/engine': { engineAbi }, '@/lib/delegated-intent': { validateIntent },
    './policy': { delegatedEngines: [engine] }, './store': { db: () => database },
    '@/lib/deployment-check': { ensureDeployment: async () => { if (state.gate) await state.gate; } },
    '@/config/deployment': { marketByEngine: () => ({ archived: false }) },
    './privy': {
      ownedWallet: async (user, address) => { assert.equal(user, 'user'); assert.equal(address, owner); return { id: 'wallet-id', address: owner }; },
      signingWallet: async () => { state.policyChecks++; if (!state.permission) throw new PublicError('Permission revoked.'); return { wallet: { id: 'wallet-id', address: owner }, config: { key: 'fake-nonsecret' } }; },
      privy: () => ({ wallets: () => ({ ethereum: () => ({ sendTransaction: async () => {
        state.broadcasts++; if (state.signingError) throw Error(typeof state.signingError === 'string' ? state.signingError : 'Ambiguous signing result');
        return { hash: `0x${String(state.broadcasts).padStart(64, '0')}` };
      } }) }) }),
    },
    '@/lib/public-client': { client: {
      getBlock: async () => { if (state.transportError) throw Error(state.transportError); return { number: state.block, timestamp: BigInt(Math.floor(Date.now() / 1000)), hash: `0x${'ab'.repeat(32)}` }; },
      getChainId: async () => state.chainId,
      readContract: async ({ functionName }) => ({ participantId: 1, previewOrder: { rejection: 0, acceptedCapLots: 10000n }, maxFills: 64, previewAccount: { positionLots: 0n } })[functionName],
      call: async () => {}, estimateGas: async () => 100000n, getBalance: async () => 10n ** 18n, getGasPrice: async () => 1n,
    } },
  });
  const route = load('../src/app/api/trade/route.ts', {
    '@/server/trade': server,
    '@/server/privy': { authenticate: async () => 'user', jsonBody: request => request.json(), apiError },
  });
  const post = async input => {
    const response = await route.POST(new Request('https://app.test/api/trade', { method: 'POST', body: JSON.stringify(input) }));
    const data = await response.json();
    if (!response.ok) throw new DelegatedDeliveryError(data.error, data.delivery ?? 'unknown');
    return data;
  };
  return { state, database, post, server };
}

test('lost response after persisted sent recovers the same actual server request across reload without another broadcast', async () => {
  const f = fixture(), memory = storage(), store = new DelegatedAttemptStore(memory, [engine], 10143);
  const original = attempt(body('original_request_0001'));
  try {
    await assert.rejects(recoverDelegatedAttempt(store, original, async input => { await f.post(input); throw Error('HTTP response lost'); }), /response lost/);
    assert.equal(f.state.broadcasts, 1);
    assert.equal(f.database.prepare('SELECT status FROM requests').get().status, 'sent');
    assert.deepEqual(store.read(owner).body, original.body);
    const reloaded = new DelegatedAttemptStore(memory, [engine], 10143);
    // Neither stale preview nor revoked additional signer prevents recovering an owned hash.
    f.state.block = 1000n; f.state.permission = false;
    const checks = f.state.policyChecks;
    const hash = await recoverDelegatedAttempt(reloaded, reloaded.read(owner), f.post);
    assert.equal(f.state.broadcasts, 1); assert.equal(f.state.policyChecks, checks);
    assert.equal(reloaded.read(owner).hash, hash);
    assert.equal(await recoverDelegatedAttempt(reloaded, reloaded.read(owner), async () => { throw Error('must not POST known hash'); }), hash);
    assert.equal(f.state.broadcasts, 1);
  } finally { f.database.close(); }
});

test('durable pre-send rejection resolves a lost response and allows a corrected new request', async () => {
  const f = fixture(), store = new DelegatedAttemptStore(storage(), [engine], 10143), original = attempt(body('rejected_request_001'));
  try {
    f.state.chainId = 1;
    await assert.rejects(recoverDelegatedAttempt(store, original, async input => { try { await f.post(input); } catch {} throw Error('HTTP response lost'); }));
    assert.equal(f.database.prepare('SELECT status FROM requests').get().status, 'rejected');
    assert.ok(store.read(owner));
    f.state.chainId = 10143;
    await assert.rejects(recoverDelegatedAttempt(store, store.read(owner), f.post), error => error.delivery === 'rejected');
    assert.equal(store.read(owner), undefined); assert.equal(f.state.broadcasts, 0);
    await recoverDelegatedAttempt(store, attempt(body('corrected_request_02')), f.post);
    assert.equal(f.state.broadcasts, 1);
  } finally { f.database.close(); }
});

test('early durable claim serializes concurrent copies and other wallet requests through preflight', async () => {
  const f = fixture(); let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  try {
    const input = body('concurrent_request_1'), first = f.post(input);
    // Wait for the real handler to acquire its durable claim, before releasing reads.
    while (!f.database.prepare('SELECT id FROM requests').get()) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(f.post(input), error => error.delivery === 'pending');
    await assert.rejects(f.post(body('different_request_02')), error => error.delivery === 'pending');
    release(); await first;
    assert.equal(f.state.broadcasts, 1);
    await assert.rejects(f.post({ ...input, place: { ...input.place, tick: 501 } }), error => error.delivery === 'unknown');
    assert.equal(f.state.broadcasts, 1);
  } finally { f.database.close(); }
});

test('a concurrent copy cannot later send after the claimed copy is durably rejected', async () => {
  const f = fixture(); let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  try {
    const input = body('concurrent_reject_01'), first = f.post(input);
    while (!f.database.prepare('SELECT id FROM requests').get()) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(f.post(input), error => error.delivery === 'pending');
    f.state.chainId = 1; release();
    await assert.rejects(first, error => error.delivery === 'rejected');
    f.state.chainId = 10143;
    await assert.rejects(f.post(input), error => error.delivery === 'rejected');
    assert.equal(f.database.prepare('SELECT status FROM requests').get().status, 'rejected');
    assert.equal(f.state.broadcasts, 0);
  } finally { f.database.close(); }
});

test('post-signature uncertainty stays blocked and changed intent cannot overwrite a saved attempt', async () => {
  const f = fixture(), store = new DelegatedAttemptStore(storage(), [engine], 10143), original = attempt(body('uncertain_request_01'));
  try {
    f.state.signingError = true;
    await assert.rejects(recoverDelegatedAttempt(store, original, f.post), error => error.delivery === 'pending');
    assert.ok(store.read(owner));
    assert.equal(f.database.prepare('SELECT status FROM requests').get().status, 'uncertain');
    assert.throws(() => store.save(attempt(body('replacement_request_2'))), /Recover/);
    await assert.rejects(recoverDelegatedAttempt(store, original, f.post), error => error.delivery === 'pending');
    assert.equal(f.state.broadcasts, 1);
    assert.equal(store.read(`0x${'3'.repeat(40)}`), undefined);
  } finally { f.database.close(); }
});

test('real trade route redacts transport errors without changing rejected and pending recovery semantics', async () => {
  const f = fixture(), store = new DelegatedAttemptStore(storage(), [engine], 10143);
  const secret = 'https://rpc.example/private-provider-token?authorization=test-private-request';
  try {
    f.state.transportError = secret;
    await assert.rejects(recoverDelegatedAttempt(store, attempt(body('redacted_rejected_01')), f.post), error => {
      assert.equal(error.delivery, 'rejected');
      assert.doesNotMatch(error.message, /private-provider-token|test-private-request|rpc\.example/);
      assert.match(error.message, /Check your login/);
      return true;
    });
    assert.equal(store.read(owner), undefined, 'durable pre-sign rejection may clear recovery');
    assert.equal(f.state.broadcasts, 0);
    f.state.transportError = undefined;
    f.state.signingError = secret;
    await assert.rejects(recoverDelegatedAttempt(store, attempt(body('redacted_pending_001')), f.post), error => {
      assert.equal(error.delivery, 'pending');
      assert.doesNotMatch(error.message, /private-provider-token|test-private-request|rpc\.example/);
      assert.match(error.message, /Recover this request/);
      return true;
    });
    assert.ok(store.read(owner), 'ambiguous signing must retain the exact recovery request');
    assert.equal(f.state.broadcasts, 1);
  } finally { f.database.close(); }
});

test('saved calldata binding detects corruption and malformed hash responses retain the original attempt', async () => {
  const memory = storage(), store = new DelegatedAttemptStore(memory, [engine], 10143), original = attempt(body('malformed_request_01'));
  await assert.rejects(recoverDelegatedAttempt(store, original, async () => ({ hash: 'bad' })), /invalid transaction hash/);
  assert.deepEqual(store.read(owner).body, original.body);
  memory.setItem(`eros-delegated-attempt:10143:${owner}`, JSON.stringify({ ...original, calldata: '0xdead' }));
  assert.throws(() => store.read(owner), /saved trading request is invalid/);
});

test('saved request is bound to owner, chain, engine, calldata and wallet session', () => {
  const original = attempt(body('bound_request_0001'));
  const call = { owner, chainId: 10143, engine, action: 'placeOrder', calldata: original.calldata, connectorUid: original.connectorUid, sessionVersion: original.sessionVersion };
  assert.doesNotThrow(() => assertAttemptBinding(original, call));
  for (const change of [{owner:engine},{chainId:1},{engine:owner},{action:'cancelAll'},{calldata:'0xdead'},{connectorUid:'other'},{sessionVersion:4}]) {
    assert.throws(() => assertAttemptBinding(original, {...call,...change}), /Recover/);
  }
  // Explicit recovery may reauthorize a session after reload, but never another owner/call.
  assert.doesNotThrow(() => assertAttemptBinding(original, {...call,connectorUid:'reloaded',sessionVersion:0}, true));
  assert.throws(() => assertAttemptBinding(original, {...call,owner:engine}, true), /Recover/);
});

test('canonical reverted receipt clears only the saved exact owner call, while a mismatch remains recoverable', async () => {
  const store = new DelegatedAttemptStore(storage(), [engine], 10143), original = attempt(body('reverted_request_001'));
  const hash = `0x${'8'.repeat(64)}`, blockHash = `0x${'9'.repeat(64)}`;
  store.save({...original,hash});
  const receipt = {transactionHash:hash,blockHash,blockNumber:12n,status:'reverted',logs:[]};
  let wrongSender = true;
  const rpc = { waitForTransactionReceipt:async()=>receipt,getTransactionReceipt:async()=>receipt,
    getBlock:async()=>({number:12n,hash:blockHash}),
    getTransaction:async()=>({hash,blockHash,blockNumber:12n,from:wrongSender?engine:owner,to:engine,input:original.calldata,value:0n}),
  };
  const confirm = () => finalizedOwnerReceipt(rpc, hash, {owner,to:engine,data:original.calldata});
  await assert.rejects(confirmDelegatedAttempt(store, original, confirm), /identity/);
  assert.equal(store.read(owner).hash, hash);
  wrongSender = false;
  await assert.rejects(confirmDelegatedAttempt(store, original, confirm), FinalizedOwnerRevert);
  assert.equal(store.read(owner), undefined);
  store.save(attempt(body('explicit_new_order_1')));
  assert.equal(store.read(owner).body.clientNonce, 'explicit_new_order_1');
});
