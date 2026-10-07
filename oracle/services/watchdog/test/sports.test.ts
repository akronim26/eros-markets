import { test, expect } from 'bun:test'
import fixtures from '../../../packages/feedspec/test/fixtures/sports.json'
import { sportsFeed, type SportsBinding } from '../../../packages/feedspec/src/sports'
import { evaluateFeed } from '../src/l1'

test('watchdog independently fetches and binds the F1 companion using the CRE rules', async () => {
  const fixture = fixtures.find(f => f.binding.sport === 'formula-1')!
  const feed = sportsFeed(fixture.binding as SportsBinding, '0x' + 'ab'.repeat(32))
  for (const broken of [false, true]) {
    const urls: string[] = []
    const result = await evaluateFeed(feed, { auth: () => ({ header: 'x-apisports-key', value: 'test-only' }),
      fetchFn: (async (url: string, init: RequestInit) => {
        urls.push(url)
        expect((init.headers as Record<string, string>)['x-apisports-key']).toBe('test-only')
        expect(init.redirect).toBe('manual')
        const data: any = structuredClone(urls.length === 1 ? fixture.response : fixture.companion)
        if (broken && urls.length === 2) data.response[0].race.id++
        return new Response(JSON.stringify(data))
      }) as unknown as typeof fetch,
    })
    expect(urls).toEqual(['https://v1.formula-1.api-sports.io/races?id=1857', 'https://v1.formula-1.api-sports.io/rankings/races?race=1857'])
    expect(result.status).toBe(broken ? 'ERROR' : 'YES')
  }
})

test('oversized F1 classification streams stop at the shared body cap', async () => {
  const fixture = fixtures.find(f => f.binding.sport === 'formula-1')!
  const feed = sportsFeed(fixture.binding as SportsBinding, '0x' + 'ab'.repeat(32))
  let calls = 0, reads = 0, cancelled = false
  const result = await evaluateFeed(feed, { auth: () => ({ header: 'x-apisports-key', value: 'test-only' }),
    fetchFn: (async () => {
      if (++calls === 1) return Response.json(fixture.response)
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(128 * 1024)); if (reads === 20) controller.close() },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 }))
    }) as unknown as typeof fetch,
  })
  expect(result.status).toBe('ERROR')
  expect(result.code).toBe('SPORTS_COMPANION_UNAVAILABLE')
  expect(reads).toBe(2)
  expect(cancelled).toBe(true)
})
