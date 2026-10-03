// Task O34.1: the console's local evidence store (ADJ-41). Snapshots are the panel runner's files, `<evidenceHash>.json`
// (canonical bytes) and `<evidenceHash>.panel.json` (the run's record); a reviewer's re-snapshot is written the same way.
// Every snapshot read is checked against its hash. Notes go to `notes/<noteHash>.json`.
import type { PanelRecord } from '@eros-oracle/panel-runner'
import { canonicalBytes, evidenceHash, type Snapshot } from '@eros-oracle/snapshotter'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, keccak256 } from 'viem'
import { type Note, noteHash } from './note'

export const SNAPSHOT_URI_PREFIX = 'eros-snapshot:'
export const snapshotURI = (h: Hex) => `${SNAPSHOT_URI_PREFIX}${h.toLowerCase()}`

/** The evidenceHash an `eros-snapshot:` URI names; null for any other URI. */
export function hashFromURI(uri: string): Hex | null {
  const m = /^eros-snapshot:(0x[0-9a-fA-F]{64})$/.exec(uri)
  return m ? (m[1].toLowerCase() as Hex) : null
}

export class EvidenceMismatch extends Error {}

const HASH = /^0x[0-9a-f]{64}$/

export class EvidenceStore {
  constructor(readonly dir: string) {}

  private path(name: string) {
    if (!HASH.test(name.split('.')[0])) throw new Error(`not a hash: ${name}`)
    return join(this.dir, name)
  }

  /** The snapshot stored under `hash`, checked against it; null when the store does not have it. */
  snapshot(hash: Hex): Snapshot | null {
    const p = this.path(`${hash.toLowerCase()}.json`)
    if (!existsSync(p)) return null
    const bytes = readFileSync(p)
    if (keccak256(bytes) !== hash.toLowerCase()) throw new EvidenceMismatch(`${p} does not hash to ${hash}`)
    return JSON.parse(bytes.toString('utf8'))
  }

  putSnapshot(s: Snapshot): { evidenceHash: Hex; evidenceURI: string } {
    const h = evidenceHash(s)
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(`${h}.json`), canonicalBytes(s))
    return { evidenceHash: h, evidenceURI: snapshotURI(h) }
  }

  panelRecord(hash: Hex): PanelRecord | null {
    const p = this.path(`${hash.toLowerCase()}.panel.json`)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  }

  putNote(note: Note): Hex {
    const h = noteHash(note)
    mkdirSync(join(this.dir, 'notes'), { recursive: true })
    writeFileSync(join(this.dir, 'notes', `${h}.json`), canonicalBytes(note))
    return h
  }

  note(hash: Hex): Note | null {
    const p = join(this.dir, 'notes', `${hash.toLowerCase()}.json`)
    if (!HASH.test(hash.toLowerCase()) || !existsSync(p)) return null
    const bytes = readFileSync(p)
    if (keccak256(bytes) !== hash.toLowerCase()) throw new EvidenceMismatch(`${p} does not hash to ${hash}`)
    return JSON.parse(bytes.toString('utf8'))
  }
}
