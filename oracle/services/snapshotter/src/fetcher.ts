// Evidence fetcher. Order: the Layer 1 endpoint, allow-listed pages by host order, then other pages as context. Plain
// GETs with no credentials and no redirects followed, so a redirect cannot swap in another host's page. Bodies are
// stored raw, capped at 512 KB per item and 4 MB per snapshot; sources past the cap are listed as omitted.
import { hostOf } from '@eros-oracle/feedspec'
import { createHash } from 'node:crypto'
import {
  FETCH_TIMEOUT_MS,
  ITEM_CAP_BYTES,
  type Item,
  type Omitted,
  SNAPSHOT_CAP_BYTES,
  SNAPSHOT_VERSION,
  type Snapshot,
  type SnapshotRequest,
} from './types'

export type FetcherOptions = {
  fetchFn?: typeof fetch
  /** Unix seconds. */
  clock?: () => number
  timeoutMs?: number
  itemCapBytes?: number
  snapshotCapBytes?: number
}

const HEADERS = { accept: '*/*', 'user-agent': 'eros-snapshotter/1' }

type Source = { url: string; host: string; allowListed: boolean }

/** Deduplicated, in snapshot order; URLs that are not https with a plain host are omitted. */
export function orderSources(req: SnapshotRequest): { sources: Source[]; omitted: Omitted[] } {
  const seen = new Set<string>()
  const omitted: Omitted[] = []
  const parsed: (Source & { rank: number })[] = []
  const add = (url: string, rank: number) => {
    if (seen.has(url)) return
    seen.add(url)
    let host: string
    try {
      host = hostOf(url) // the registry's host rules
    } catch {
      omitted.push({ url, reason: 'BAD_URL' })
      return
    }
    const i = req.allowList.indexOf(host)
    parsed.push({ url, host, allowListed: i >= 0, rank: rank >= 0 ? rank : i >= 0 ? 1 + i : 1 + req.allowList.length })
  }
  if (req.l1Url !== undefined) add(req.l1Url, 0)
  for (const url of req.pages) add(url, -1)
  // Stable sort: Layer 1, then allow-listed pages by host order, then context; configured order within each.
  const sources = parsed.map((s, i) => ({ s, i })).sort((a, b) => a.s.rank - b.s.rank || a.i - b.i).map(({ s }) => ({ url: s.url, host: s.host, allowListed: s.allowListed }))
  return { sources, omitted }
}

export async function takeSnapshot(req: SnapshotRequest, o: FetcherOptions = {}): Promise<Snapshot> {
  const clock = o.clock ?? (() => Math.floor(Date.now() / 1000))
  const snapshotCap = o.snapshotCapBytes ?? SNAPSHOT_CAP_BYTES
  const { sources, omitted } = orderSources(req)
  const takenAt = clock()
  const items: Item[] = []
  let used = 0
  for (const src of sources) {
    const budget = Math.min(o.itemCapBytes ?? ITEM_CAP_BYTES, snapshotCap - used)
    if (budget <= 0) {
      omitted.push({ url: src.url, reason: 'SNAPSHOT_CAP' })
      continue
    }
    const item = await fetchItem(src, budget, o.fetchFn ?? fetch, clock, o.timeoutMs ?? FETCH_TIMEOUT_MS)
    used += Buffer.from(item.bytesBase64, 'base64').length
    items.push(item)
  }
  // BAD_URL entries were found while ordering; keep `omitted` in source order of the request.
  const order = new Map([...(req.l1Url !== undefined ? [req.l1Url] : []), ...req.pages].map((u, i) => [u, i]))
  omitted.sort((a, b) => (order.get(a.url) ?? 0) - (order.get(b.url) ?? 0))
  return { version: SNAPSHOT_VERSION, marketId: req.marketId, takenAt, allowList: [...req.allowList], items, omitted }
}

/** Reads at most `cap` bytes of the body. */
export async function fetchItem(src: Source, cap: number, fetchFn: typeof fetch, clock: () => number, timeoutMs: number): Promise<Item> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const failed = (error: Item['error'], fetchedAt: number): Item => ({
    ...src, fetchedAt, httpStatus: 0, contentType: '', sha256: sha256Hex(new Uint8Array()), bytesBase64: '', truncated: false, error,
  })
  try {
    let res: Response
    try {
      res = await fetchFn(src.url, { method: 'GET', headers: HEADERS, redirect: 'manual', credentials: 'omit', signal: ctl.signal })
    } catch {
      return failed(ctl.signal.aborted ? 'TIMEOUT' : 'NETWORK', clock())
    }
    const fetchedAt = clock()
    let body: { bytes: Uint8Array; truncated: boolean }
    try {
      body = await readCapped(res, cap, ctl)
    } catch {
      return failed(ctl.signal.aborted ? 'TIMEOUT' : 'NETWORK', fetchedAt)
    }
    return {
      ...src,
      fetchedAt,
      httpStatus: res.status,
      contentType: res.headers.get('content-type') ?? '',
      sha256: sha256Hex(body.bytes),
      bytesBase64: Buffer.from(body.bytes).toString('base64'),
      truncated: body.truncated,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Aborts the request past `cap`: cancelling the reader alone leaves Bun downloading the rest. */
async function readCapped(res: Response, cap: number, ctl: AbortController): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (n + value.length > cap) {
      chunks.push(value.subarray(0, cap - n))
      n = cap
      truncated = true
      ctl.abort()
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    n += value.length
  }
  const bytes = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  return { bytes, truncated }
}

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export const itemBytes = (item: Item) => new Uint8Array(Buffer.from(item.bytesBase64, 'base64'))
