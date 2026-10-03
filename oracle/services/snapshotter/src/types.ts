// The evidence snapshot. Its canonical form is hashed, so every field is plain JSON: strings, integers and booleans.

export const SNAPSHOT_VERSION = 1
export const ITEM_CAP_BYTES = 512 * 1024
export const SNAPSHOT_CAP_BYTES = 4 * 1024 * 1024 // stored bytes of all items
export const FETCH_TIMEOUT_MS = 15_000

export type SnapshotRequest = {
  marketId: string
  /** Set when the market has a feed. */
  l1Url?: string
  /** In the registry's order; `allowList[0]` is the Layer 1 host. */
  allowList: string[]
  /** Configured pages, plus a reviewer's additions. Pages on allow-listed hosts are evidence; others are context. */
  pages: string[]
}

export type Item = {
  url: string
  host: string
  /** False for context; an answer citing only context is ABSTAIN. */
  allowListed: boolean
  /** Unix seconds when the response headers arrived. */
  fetchedAt: number
  /** 0 when no response came (`error` says why). */
  httpStatus: number
  contentType: string
  /** Lowercase hex sha256 of the stored bytes. */
  sha256: string
  bytesBase64: string
  /** Only the first bytes are stored. */
  truncated: boolean
  error?: 'TIMEOUT' | 'NETWORK'
}

export type Omitted = { url: string; reason: 'BAD_URL' | 'SNAPSHOT_CAP' }

export type Snapshot = {
  version: typeof SNAPSHOT_VERSION
  marketId: string
  /** Unix seconds when the first fetch started. */
  takenAt: number
  allowList: string[]
  /** In source order. */
  items: Item[]
  /** Sources not fetched, in source order. */
  omitted: Omitted[]
}
