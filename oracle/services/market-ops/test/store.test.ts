import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex } from 'viem'
import { FileStore } from '../src/store'

test('journal survives reopening and excludes concurrent processes and different identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eros-market-ops-'))
  const path = join(directory, 'journal.json')
  const identity = toHex(1n, { size: 32 })
  try {
    const first = new FileStore(path, identity)
    expect(() => new FileStore(path, identity)).toThrow()
    const journal = first.read()
    journal.lastSampleBlock = '123'
    first.write(journal)
    first.close()
    const reopened = new FileStore(path, identity)
    expect(reopened.read().lastSampleBlock).toBe('123')
    reopened.close()
    expect(() => new FileStore(path, toHex(2n, { size: 32 }))).toThrow('different market')
    expect(JSON.parse(readFileSync(path, 'utf8')).lastSampleBlock).toBe('123')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('corrupt or tampered pending transaction cannot be rebroadcast', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eros-market-ops-'))
  const path = join(directory, 'journal.json')
  const identity = toHex(1n, { size: 32 })
  try {
    writeFileSync(path, JSON.stringify({ version: 1, binding: identity, completed: [], pending: {
      action: 'sample', requestId: identity, hash: identity, rawTransaction: '0x1234', plannedBlock: '10',
    } }))
    expect(() => new FileStore(path, identity)).toThrow('does not match')
    writeFileSync(path, '{')
    expect(() => new FileStore(path, identity)).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
