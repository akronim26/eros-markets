// A real local Bun server. `https://<host>/<path>` is routed to `http://127.0.0.1:<port>/<host>/<path>`.

export type Hit = { path: string; method: string; headers: Record<string, string> }

export const L1_JSON = '{"event":{"status":"FINAL","home":3,"away":1}}'
export const STATS_HTML =
  '<!doctype html><html><head><title>Match 1</title><style>.x{color:red}</style><script>var a = "<b>not text</b>";</script></head>' +
  '<body><!-- hidden comment --><h1>Final score</h1><p>Home&nbsp;3 &ndash; Away 1 &amp; that&#39;s it</p><div>Attendance: 41&#x2c;000</div></body></html>'
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
export const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]) // "café" in ISO-8859-1

/** Deterministic, so a test can hash the expected prefix independently. */
export const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)

export function startFixture() {
  const hits: Hit[] = []
  let streamedBytes = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      hits.push({ path: url.pathname + url.search, method: req.method, headers: Object.fromEntries(req.headers.entries()) })
      const [, host, ...rest] = url.pathname.split('/')
      const path = `${host}/${rest.join('/')}`
      const sized = /^[a-z.-]+\/bytes\/(\d+)$/.exec(path)
      if (sized) return new Response(pattern(Number(sized[1])), { headers: { 'content-type': 'application/octet-stream' } })
      switch (path) {
        case 'api.example-sports.com/v1/events/evt_1':
          return new Response(L1_JSON, { headers: { 'content-type': 'application/json' } })
        case 'stats.example-data.org/match/1':
          return new Response(STATS_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        case 'stats.example-data.org/latin1':
          return new Response(LATIN1, { headers: { 'content-type': 'text/plain; charset=ISO-8859-1' } })
        case 'stats.example-data.org/logo.png':
          return new Response(PNG, { headers: { 'content-type': 'image/png' } })
        case 'stats.example-data.org/missing':
          return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
        case 'stats.example-data.org/moved':
          return new Response('', { status: 302, headers: { location: 'https://elsewhere.example.net/page' } })
        case 'stats.example-data.org/set-cookie':
          return new Response('ok', { headers: { 'content-type': 'text/plain', 'set-cookie': 'session=abc; Path=/' } })
        case 'news.example.com/story':
          return new Response('<p>Context story</p>', { headers: { 'content-type': 'text/html' } })
        case 'api.example-sports.com/slow':
          return new Promise<Response>(() => {}) // never answers
        case 'api.example-sports.com/endless': {
          const chunk = pattern(64 * 1024)
          return new Response(
            new ReadableStream({
              async pull(c) {
                await Bun.sleep(1) // yield: the client reads in this same process
                streamedBytes += chunk.length
                c.enqueue(chunk)
              },
            }),
            { headers: { 'content-type': 'application/octet-stream' } },
          )
        }
        default:
          return new Response('no route', { status: 404 })
      }
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const target = u.hostname === 'unreachable.example' ? 'http://127.0.0.1:1/' : `${base}/${u.hostname}${u.pathname}${u.search}`
    return fetch(target, init)
  }) as typeof fetch
  return { server, hits, fetchFn, streamed: () => streamedBytes, stop: () => server.stop(true) }
}
