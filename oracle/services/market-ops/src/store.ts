import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { keccak256, type Hex } from 'viem'
import { z } from 'zod'
import { bytes32, equalHex } from './schema'

const counter = z.string().regex(/^(0|[1-9][0-9]*)$/)
const pendingSchema = z.object({
  action: z.enum(['sample', 'restrict', 'early-check', 'relay']),
  requestId: bytes32,
  hash: bytes32,
  rawTransaction: z.string().regex(/^0x([0-9a-fA-F]{2})+$/).transform(value => value as Hex),
  plannedBlock: counter,
}).strict()

export type Pending = z.infer<typeof pendingSchema>

const journalSchema = z.object({
  version: z.literal(1),
  binding: bytes32,
  lastSampleBlock: counter.optional(),
  pending: pendingSchema.optional(),
  completed: z.array(bytes32),
}).strict()

export type Journal = z.infer<typeof journalSchema>

export interface Store {
  read(): Journal
  write(journal: Journal): void
}

export class FileStore implements Store {
  private readonly lock: number
  private closed = false

  constructor(private readonly path: string, private readonly expectedBinding: Hex) {
    mkdirSync(dirname(path), { recursive: true })
    this.lock = openSync(`${path}.lock`, 'wx', 0o600)
    writeFileSync(this.lock, `${process.pid}\n`)
    try {
      this.read()
    } catch (error) {
      this.close()
      throw error
    }
  }

  read(): Journal {
    const journal = existsSync(this.path)
      ? journalSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { version: 1 as const, binding: this.expectedBinding, completed: [] }
    if (!equalHex(journal.binding, this.expectedBinding)) throw new Error('Journal belongs to a different market, sender or deployment')
    if (journal.pending && !equalHex(keccak256(journal.pending.rawTransaction), journal.pending.hash)) {
      throw new Error('Journal transaction hash does not match signed bytes')
    }
    return journal
  }

  write(journal: Journal): void {
    journalSchema.parse(journal)
    if (!equalHex(journal.binding, this.expectedBinding)) throw new Error('Journal binding changed')
    const temporary = `${this.path}.tmp`
    const handle = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(handle, JSON.stringify(journal, null, 2))
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, this.path)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeSync(this.lock)
    unlinkSync(`${this.path}.lock`)
  }
}
