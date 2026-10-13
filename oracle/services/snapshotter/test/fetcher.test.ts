// Expected hashes are computed here from the fixture's bytes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { itemBytes, orderSources, takeSnapshot } from '../src/fetcher'
import { ITEM_CAP_BYTES, SNAPSHOT_CAP_BYTES, type SnapshotRequest } from '../src/types'
import { L1_JSON, pattern, startFixture, STATS_HTML } from './fixture'

const MARKET = '0xe085067fb3e1eba632de103ba472329d833cddefdb9296cc70569d9b080d5fcf'
const ALLOW = ['api.example-sports.com', 'stats.example-data.org']
const L1 = 'https://api.example-sports.com/v1/events/evt_1'
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const enc = (s: string) => new TextEncoder().encode(s)
/** `null` for a market without a feed. */
const req = (pages: string[], l1: string | null = L1): SnapshotRequest => ({ marketId: MARKET, l1Url: l1 ?? undefined, allowList: ALLOW, pages })

let fx: ReturnType<typeof startFixture>
let t = 1_800_000_000
const clock = () => t++

beforeAll(() => {
  fx = startFixture()
})
afterAll(() => fx.stop())

describe('source order', () => {
  test('Layer 1 first, then allow-listed pages in allow-list host order, then context; duplicates once', () => {
    const { sources, omitted } = orderSources(
      req([
        'https://news.example.com/story', // context
        'https://stats.example-data.org/match/1', // second host
        'https://api.example-sports.com/v1/standings', // first host
        L1, // the Layer 1 URL again
        'https://stats.example-data.org/match/2',
        'https://blog.example.org/post', // context
        'https://stats.example-data.org/match/1', // duplicate
      ]),
    )
    expect(sources).toEqual([
      { url: L1, host: 'api.example-sports.com', allowListed: true },
      { url: 'https://api.example-sports.com/v1/standings', host: 'api.example-sports.com', allowListed: true },
      { url: 'https://stats.example-data.org/match/1', host: 'stats.example-data.org', allowListed: true },
      { url: 'https://stats.example-data.org/match/2', host: 'stats.example-data.org', allowListed: true },
      { url: 'https://news.example.com/story', host: 'news.example.com', allowListed: false },
      { url: 'https://blog.example.org/post', host: 'blog.example.org', allowListed: false },
    ])
    expect(omitted).toEqual([])
  })

  test('without a feed the allow-listed pages come first', () => {
    const { sources } = orderSources(req(['https://news.example.com/story', 'https://stats.example-data.org/match/1'], null))
    expect(sources.map((s) => s.url)).toEqual(['https://stats.example-data.org/match/1', 'https://news.example.com/story'])
  })

  test('a URL that is not https with a plain lowercase host is omitted as BAD_URL', () => {
    const bad = ['http://stats.example-data.org/match/1', 'https://Stats.example-data.org/x', 'https://stats.example-data.org:8443/x', 'https://user@stats.example-data.org/x', 'not a url']
    const { sources, omitted } = orderSources(req(bad))
    expect(sources.map((s) => s.url)).toEqual([L1])
    expect(omitted).toEqual(bad.map((url) => ({ url, reason: 'BAD_URL' })))
  })

  test('the snapshot fetches in that order', async () => {
    const before = fx.hits.length
    const s = await takeSnapshot(req(['https://news.example.com/story', 'https://stats.example-data.org/match/1']), { fetchFn: fx.fetchFn, clock })
    expect(s.items.map((i) => i.url)).toEqual([L1, 'https://stats.example-data.org/match/1', 'https://news.example.com/story'])
    expect(fx.hits.slice(before).map((h) => h.path)).toEqual(['/api.example-sports.com/v1/events/evt_1', '/stats.example-data.org/match/1', '/news.example.com/story'])
    expect(s.items.map((i) => i.allowListed)).toEqual([true, true, false])
  })
})

describe('item format', () => {
  test('{url, host, allowListed, fetchedAt, httpStatus, contentType, sha256, bytesBase64, truncated}, bytes stored raw', async () => {
    t = 1_800_000_000
    const s = await takeSnapshot(req(['https://stats.example-data.org/match/1', 'https://stats.example-data.org/missing']), { fetchFn: fx.fetchFn, clock })
    expect(s.version).toBe(1)
    expect(s.marketId).toBe(MARKET)
    expect(s.takenAt).toBe(1_800_000_000)
    expect(s.allowList).toEqual(ALLOW)
    expect(s.omitted).toEqual([])
    const [l1, html, missing] = s.items
    expect(l1).toEqual({
      url: L1,
      host: 'api.example-sports.com',
      allowListed: true,
      fetchedAt: 1_800_000_001,
      httpStatus: 200,
      contentType: 'application/json',
      sha256: sha(L1_JSON),
      bytesBase64: Buffer.from(L1_JSON).toString('base64'),
      truncated: false,
    })
    expect(Object.keys(html).sort()).toEqual(['allowListed', 'bytesBase64', 'contentType', 'fetchedAt', 'host', 'httpStatus', 'sha256', 'truncated', 'url'])
    expect(html.contentType).toBe('text/html; charset=utf-8')
    expect(Buffer.compare(Buffer.from(itemBytes(html)), Buffer.from(STATS_HTML))).toBe(0) // raw HTML, scripts and all
    expect(html.sha256).toBe(sha(STATS_HTML))
    expect(missing.httpStatus).toBe(404) // an error page is evidence of what the source said
    expect(Buffer.from(itemBytes(missing)).toString()).toBe('not found')
  })

  test('a fetch that gets no response is an item with httpStatus 0 and its reason', async () => {
    const s = await takeSnapshot(req(['https://unreachable.example/x', 'https://api.example-sports.com/slow'], null), { fetchFn: fx.fetchFn, clock, timeoutMs: 300 })
    expect(s.items.map((i) => [i.url, i.httpStatus, i.error, i.bytesBase64, i.sha256])).toEqual([
      ['https://api.example-sports.com/slow', 0, 'TIMEOUT', '', sha(new Uint8Array())], // allow-listed first
      ['https://unreachable.example/x', 0, 'NETWORK', '', sha(new Uint8Array())],
    ])
  })
})

describe('caps', () => {
  test('512 KB per item: a longer body keeps its first 512 KB, marked truncated; exactly 512 KB is whole', async () => {
    const s = await takeSnapshot(req([`https://stats.example-data.org/bytes/${ITEM_CAP_BYTES + 1}`, `https://stats.example-data.org/bytes/${ITEM_CAP_BYTES}`], null), { fetchFn: fx.fetchFn, clock })
    const [over, exact] = s.items
    expect(itemBytes(over).length).toBe(524_288)
    expect(over.truncated).toBe(true)
    expect(over.sha256).toBe(sha(pattern(524_288)))
    expect(itemBytes(exact).length).toBe(524_288)
    expect(exact.truncated).toBe(false)
    expect(exact.sha256).toBe(sha(pattern(524_288)))
  })

  test('an endless body stops at the cap and the download is cancelled', async () => {
    const s = await takeSnapshot(req(['https://api.example-sports.com/endless'], null), { fetchFn: fx.fetchFn, clock })
    expect(itemBytes(s.items[0]).length).toBe(ITEM_CAP_BYTES)
    expect(s.items[0].truncated).toBe(true)
    await Bun.sleep(200)
    expect(fx.streamed()).toBeLessThan(2 * ITEM_CAP_BYTES) // the connection was closed, not left downloading
  })

  test('4 MB per snapshot: eight full items fill it; the rest are omitted, not fetched', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => `https://stats.example-data.org/bytes/${ITEM_CAP_BYTES + 1000 + i}`)
    const before = fx.hits.length
    const s = await takeSnapshot(req(pages, null), { fetchFn: fx.fetchFn, clock })
    expect(s.items.length).toBe(8)
    expect(s.items.reduce((n, i) => n + itemBytes(i).length, 0)).toBe(SNAPSHOT_CAP_BYTES)
    expect(s.omitted).toEqual(pages.slice(8).map((url) => ({ url, reason: 'SNAPSHOT_CAP' })))
    expect(fx.hits.length - before).toBe(8)
  })

  test('the item that crosses the snapshot budget is cut to what is left', async () => {
    const pages = [100, 100, 100, 100].map((n, i) => `https://stats.example-data.org/bytes/${n + i}`)
    const s = await takeSnapshot(req(pages, null), { fetchFn: fx.fetchFn, clock, snapshotCapBytes: 250 })
    expect(s.items.map((i) => [itemBytes(i).length, i.truncated])).toEqual([[100, false], [101, false], [49, true]])
    expect(s.items[2].sha256).toBe(sha(pattern(49)))
    expect(s.omitted).toEqual([{ url: pages[3], reason: 'SNAPSHOT_CAP' }])
  })

  test('omitted entries keep request order whatever the reason', async () => {
    // a BAD_URL is found while ordering, before any fetch; a SNAPSHOT_CAP only after the fetches
    const pages = ['https://stats.example-data.org/bytes/200', 'https://stats.example-data.org/bytes/201', 'http://bad.example/x']
    const s = await takeSnapshot(req(pages, null), { fetchFn: fx.fetchFn, clock, snapshotCapBytes: 200 })
    expect(s.omitted).toEqual([{ url: pages[1], reason: 'SNAPSHOT_CAP' }, { url: pages[2], reason: 'BAD_URL' }])
  })
})

describe('plain GETs', () => {
  test('GET with only accept and user-agent: no cookie, no credentials, even after a Set-Cookie', async () => {
    const before = fx.hits.length
    await takeSnapshot(req(['https://stats.example-data.org/set-cookie', 'https://stats.example-data.org/match/1'], null), { fetchFn: fx.fetchFn, clock })
    const hits = fx.hits.slice(before)
    expect(hits.length).toBe(2)
    for (const h of hits) {
      expect(h.method).toBe('GET')
      expect(h.headers.cookie).toBeUndefined()
      expect(h.headers.authorization).toBeUndefined()
      expect(h.headers.accept).toBe('*/*')
      expect(h.headers['user-agent']).toBe('eros-snapshotter/1')
    }
  })

  test('a redirect is stored as it came and not followed', async () => {
    const before = fx.hits.length
    const s = await takeSnapshot(req(['https://stats.example-data.org/moved'], null), { fetchFn: fx.fetchFn, clock })
    expect(s.items[0].httpStatus).toBe(302)
    expect(fx.hits.slice(before).map((h) => h.path)).toEqual(['/stats.example-data.org/moved'])
  })
})
