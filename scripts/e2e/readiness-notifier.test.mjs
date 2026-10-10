import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadinessNotifier, writeNotice } from './readiness-notifier.mjs';

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eros-notice-'));

test('a finalized INDEX notice wakes a waiting maker long before the fallback', async () => {
  const dir = directory();
  const notifier = new ReadinessNotifier({ directory: dir });
  try {
    assert.equal(notifier.watching, true);
    const started = Date.now();
    const waiting = notifier.wait(15_000);
    setTimeout(() => writeNotice(dir, 'index-notice.json', { sequence: '1' }), 50);
    assert.equal(await waiting, 'notified');
    assert.ok(Date.now() - started < 5_000);
  } finally { notifier.close(); fs.rmSync(dir, { recursive: true }); }
});

test('unrelated files do not wake the maker; the fallback still bounds the wait', async () => {
  const dir = directory();
  const notifier = new ReadinessNotifier({ directory: dir });
  try {
    const waiting = notifier.wait(300);
    fs.writeFileSync(path.join(dir, 'maker-journal.json'), '{}');
    assert.equal(await waiting, 'timeout');
  } finally { notifier.close(); fs.rmSync(dir, { recursive: true }); }
});

test('a notice between reads and the wait is not lost', async () => {
  const notifier = new ReadinessNotifier({ directory: undefined });
  const before = notifier.version;
  notifier.notify();
  assert.equal(await notifier.wait(10_000, before), 'notified');
});

test('without a coordination directory the maker keeps plain bounded polling', async () => {
  const notifier = new ReadinessNotifier({});
  assert.equal(notifier.watching, false);
  assert.equal(await notifier.wait(20), 'timeout');
  assert.equal(await notifier.wait(0), 'timeout');
  assert.throws(() => notifier.wait(-1), /INVALID_READINESS_WAIT/);
});

test('a watcher that cannot start degrades to the fallback delay', async () => {
  const dir = directory();
  const notifier = new ReadinessNotifier({ directory: dir, watch: () => { throw Error('EMFILE'); } });
  try {
    assert.equal(notifier.watching, false);
    assert.equal(await notifier.wait(20), 'timeout');
  } finally { notifier.close(); fs.rmSync(dir, { recursive: true }); }
});

test('only known notices can be written', () => {
  assert.throws(() => writeNotice('tmp/x', 'roles.env', {}), /UNKNOWN_READINESS_NOTICE/);
  assert.doesNotThrow(() => writeNotice(undefined, 'index-notice.json', {}));
});
