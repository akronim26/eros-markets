import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import type { RunResult } from './runner'

type Submission = { version: 1; key: string; status: 'broadcasting' | 'pending' | 'confirmed' | 'reverted'; result: RunResult }
const hash = /^0x[0-9a-fA-F]{64}$/

/** One writer per directory. A pre-send marker survives even an ambiguous broadcast or process crash. */
export class SubmissionStore {
  readonly dir: string
  constructor(root: string, chainId: number, oracle: Hex) {
    this.dir = join(root, 'submissions', `${chainId}-${oracle.toLowerCase()}`)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }
  private path(id: Hex) {
    if (!hash.test(id)) throw new Error('Invalid panel market ID')
    return join(this.dir, `${id.toLowerCase()}.json`)
  }
  ids(): Hex[] {
    return readdirSync(this.dir).filter(name => /^0x[0-9a-fA-F]{64}\.json$/.test(name)).map(name => name.slice(0, -5) as Hex)
  }
  read(id: Hex): Submission | undefined {
    const path = this.path(id)
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as Submission
    if (value.version !== 1 || typeof value.key !== 'string' || !['broadcasting', 'pending', 'confirmed', 'reverted'].includes(value.status)
      || value.result?.id?.toLowerCase() !== id.toLowerCase() || !hash.test(value.result.evidenceHash)
      || ![1, 2].includes(value.result.phase) || (value.result.sent !== undefined && !hash.test(value.result.sent))
      || (['pending', 'confirmed'].includes(value.status) && !value.result.sent)) throw new Error('Invalid panel submission journal; operator reconciliation required')
    return value
  }
  write(id: Hex, value: Omit<Submission, 'version'>) {
    const path = this.path(id)
    const fd = openSync(`${path}.tmp`, 'w', 0o600)
    try { writeFileSync(fd, JSON.stringify({ version: 1, ...value }) + '\n'); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(`${path}.tmp`, path)
    const directory = openSync(this.dir, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}
