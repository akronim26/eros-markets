import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWalletGuard, runWalletCalls } from '../src/lib/wallet-safety.ts';

const chainId = 10143;
const external = '0x1111111111111111111111111111111111111111';
const embedded = '0x2222222222222222222222222222222222222222';
function session(address = external) {
  return { ready: true, address, chainId, connectorUid: `wallet:${address}`, version: 0 };
}

for (const address of [external, embedded]) {
  test(`approval, deposit and allocation use one session (${address === external ? 'external' : 'embedded'})`, async () => {
    const guard = createWalletGuard(() => session(address), address, chainId);
    const events = [];
    await runWalletCalls(['approve', 'deposit', 'allocate'], {
      assertCurrent: guard.assertCurrent,
      prepare: async (call) => { events.push(`prepare:${call}`); return call; },
      send: async (call) => { events.push(`send:${call}`); return `hash:${call}`; },
      confirm: async (hash, call, last) => { events.push(`confirm:${call}:${last}`); },
    });
    assert.deepEqual(events, ['prepare:approve', 'send:approve', 'confirm:approve:false', 'prepare:deposit', 'send:deposit', 'confirm:deposit:false', 'prepare:allocate', 'send:allocate', 'confirm:allocate:true']);
  });
}

test('unready, disconnected, stale account and wrong network never start a sequence', () => {
  for (const current of [
    { ...session(), ready: false },
    { ...session(), connectorUid: undefined },
    session(embedded),
    { ...session(), chainId: 1 },
  ]) assert.throws(() => createWalletGuard(() => current, external, chainId));
});

test('switching accounts during simulation prevents any wallet request', async () => {
  let current = session();
  const guard = createWalletGuard(() => current, external, chainId);
  let sent = false;
  await assert.rejects(runWalletCalls(['approve'], {
    assertCurrent: guard.assertCurrent,
    prepare: async () => { current = session(embedded); },
    send: async () => { sent = true; },
    confirm: async () => {},
  }), /Remaining steps were stopped/);
  assert.equal(sent, false);
});

for (const change of ['account', 'network', 'disconnect', 'connector', 'logout']) {
  test(`${change} after approval stops deposit and allocation`, async () => {
    let current = session();
    const guard = createWalletGuard(() => current, external, chainId);
    const sent = [];
    await assert.rejects(runWalletCalls(['approve', 'deposit', 'allocate'], {
      assertCurrent: guard.assertCurrent,
      prepare: async (call) => call,
      send: async (call) => { sent.push(call); return 'hash'; },
      confirm: async () => {
        if (change === 'account') current = session(embedded);
        if (change === 'network') current = { ...current, chainId: 1 };
        if (change === 'disconnect') current = { ...current, ready: false };
        if (change === 'connector') current = { ...current, connectorUid: 'another provider' };
        if (change === 'logout') current = { ...current, version: current.version + 1 };
      },
    }), /Remaining steps were stopped/);
    assert.deepEqual(sent, ['approve']);
  });
}

test('switching away and back does not resume a previously authorized sequence', () => {
  let current = session();
  const guard = createWalletGuard(() => current, external, chainId);
  current = session(embedded);
  guard.observe();
  current = session();
  assert.throws(guard.assertCurrent, /Remaining steps were stopped/);
});

test('a transaction broadcast during a switch is still tracked, with no subsequent send', async () => {
  let current = session();
  const guard = createWalletGuard(() => current, external, chainId);
  const confirmed = [];
  await assert.rejects(runWalletCalls(['approve', 'deposit'], {
    assertCurrent: guard.assertCurrent,
    prepare: async (call) => call,
    send: async () => { current = session(embedded); return 'already-broadcast'; },
    confirm: async (hash) => { confirmed.push(hash); },
  }), /Remaining steps were stopped/);
  assert.deepEqual(confirmed, ['already-broadcast']);
});

test('a rejected wallet prompt stops the flow and does not wait for a nonexistent transaction', async () => {
  const guard = createWalletGuard(() => session(), external, chainId);
  const sent = [];
  let confirmed = false;
  await assert.rejects(runWalletCalls(['approve', 'deposit'], {
    assertCurrent: guard.assertCurrent,
    prepare: async (call) => call,
    send: async (call) => { sent.push(call); throw new Error('User rejected request'); },
    confirm: async () => { confirmed = true; },
  }), /User rejected/);
  assert.deepEqual(sent, ['approve']);
  assert.equal(confirmed, false);
});
