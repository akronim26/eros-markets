// Task O32.1: the evidence snapshot (plan §8.2). A snapshot is what the Layer 2 panel judges and the committee
// reads; it is pinned publicly (O32.3) and its canonical form is hashed into `evidenceHash` (O32.2), so every field
// here is plain JSON: strings, integers and booleans, no floats, no undefined.

export const SNAPSHOT_VERSION = 1
export const ITEM_CAP_BYTES = 512 * 1024 // plan §8.2: 512 KB per item
export const SNAPSHOT_CAP_BYTES = 4 * 1024 * 1024 // plan §8.2: 4 MB per snapshot (stored bytes of all items)
export const FETCH_TIMEOUT_MS = 15_000

/** Where the snapshot's sources come from: the market's FeedSpec URL, allow-list and configured pages. */
export type SnapshotRequest = {
  marketId: string
  /** The Layer 1 endpoint (FeedSpec `buildUrl`) when the market has a feed. */
  l1Url?: string
  /** The market's allow-listed hosts, in the registry's order (`allowList[0]` is the Layer 1 host). */
  allowList: string[]
  /**
   * Provider endpoints and pages configured for the market (listing pack) and, for a reviewer's re-snapshot, the
   * pages they add. A page on an allow-listed host is evidence; any other is context.
   */
  pages: string[]
}

export type Item = {
  url: string
  host: string
  /** false for context: a model answer that cites only such items is ABSTAIN (plan §8.2). */
  allowListed: boolean
  /** Unix seconds when the response headers arrived. */
  fetchedAt: number
  /** 0 when no response came (`error` says why). */
  httpStatus: number
  contentType: string
  /** Lowercase hex sha256 of the stored bytes. */
  sha256: string
  bytesBase64: string
  /** The body was longer than the per-item cap or the snapshot's remaining budget; the first bytes are stored. */
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
  /** In source order: Layer 1, then allow-listed pages by host order, then context pages. */
  items: Item[]
  /** Sources not fetched, in source order. */
  omitted: Omitted[]
}
