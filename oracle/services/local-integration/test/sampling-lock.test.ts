import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryLocalSamplingLock, withLocalSamplingLock } from '../../../../packages/pricefeed/scripts/local-sampling-lock'

test('local source delivery waits until book capture reconciliation releases the lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eros-sampling-'))
  const path = join(directory, 'sampling.lock')
  try {
    const release = tryLocalSamplingLock(path)!
    expect(tryLocalSamplingLock(path)).toBeNull()
    let published = false
    const publisher = withLocalSamplingLock(path, async () => { published = true })
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(published).toBe(false)
    release()
    await publisher
    expect(published).toBe(true)
    tryLocalSamplingLock(path)!()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('failed local publication releases the lock for reconciliation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eros-sampling-'))
  const path = join(directory, 'sampling.lock')
  try {
    await expect(withLocalSamplingLock(path, async () => { throw new Error('publication failed') })).rejects.toThrow('publication failed')
    const release = tryLocalSamplingLock(path)
    expect(release).not.toBeNull()
    release!()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('changed lock ownership fails closed without removing the other owner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eros-sampling-'))
  const path = join(directory, 'sampling.lock')
  try {
    const release = tryLocalSamplingLock(path)!
    writeFileSync(path, 'different owner')
    expect(release).toThrow('LOCAL_SAMPLING_LOCK_OWNER_CHANGED')
    expect(readFileSync(path, 'utf8')).toBe('different owner')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
