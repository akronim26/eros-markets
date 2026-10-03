// Task O34.1: the reviewer's note (plan §8.4). `noteHash = keccak256(JCS(note))` is signed in the ReviewedProposal; the
// note itself is kept by the console as its canonical bytes under that hash (ADJ-41: no IPFS pinning on testnet).
import { canonicalBytes } from '@eros-oracle/snapshotter'
import { type Address, getAddress, type Hex, keccak256 } from 'viem'
import { CHOICES, type Choice } from './types'

export const NOTE_MAX_CHARS = 4000

export type Note = {
  version: 1
  marketId: Hex
  outcome: Choice
  /** The snapshot the reviewer decided on. */
  evidenceHash: Hex
  /** Pages the reviewer added to the panel's sources (a new snapshot, ADJ-22). */
  addedSources: string[]
  reviewer: Address
  text: string
  /** Unix seconds. */
  writtenAt: number
}

export class NoteError extends Error {}

export function makeNote(n: Omit<Note, 'version'>): Note {
  if (!CHOICES.includes(n.outcome)) throw new NoteError(`outcome must be YES, NO or INVALID, not ${n.outcome}`)
  const text = n.text.trim()
  if (text === '') throw new NoteError('a note is required: say why the rules give this outcome')
  if (text.length > NOTE_MAX_CHARS) throw new NoteError(`note longer than ${NOTE_MAX_CHARS} characters`)
  if (!Number.isSafeInteger(n.writtenAt) || n.writtenAt < 0) throw new NoteError('writtenAt must be unix seconds')
  return {
    version: 1,
    marketId: n.marketId.toLowerCase() as Hex,
    outcome: n.outcome,
    evidenceHash: n.evidenceHash.toLowerCase() as Hex,
    addedSources: [...n.addedSources],
    reviewer: getAddress(n.reviewer),
    text,
    writtenAt: n.writtenAt,
  }
}

export const noteHash = (note: Note): Hex => keccak256(canonicalBytes(note))
