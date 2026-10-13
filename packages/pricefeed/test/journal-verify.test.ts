import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/journal.js';

test('verify streams the archive and still detects a tampered capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-verify-'));
  try {
    const path = join(dir, 'source.sqlite'), journal = new Journal(path);
    const fence = journal.acquire('w', 'owner', 1000n, 60_000n);
    for (let i = 0; i < 2000; i++) journal.append('w', 'owner', fence, 1000n + BigInt(i), { i, book: 'x'.repeat(200) });
    assert.equal(journal.verify(), true);
    journal.close();
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE captures SET payload=? WHERE id=1500').run('{"tampered":true}');
    raw.close();
    const reopened = new Journal(path, true);
    assert.equal(reopened.verify(), false);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
