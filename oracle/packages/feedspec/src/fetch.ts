// Node-mode fetch shared by both workflows. It has no package imports: each workflow has its own node_modules, so
// the caller passes in its own SDK `text` and keccak.
import { evaluateResponse, type FeedSpec, MAX_BODY_BYTES } from './index'
import { sportsCompanionUrl } from './sports'

export const ZERO32 = `0x${'00'.repeat(32)}`

/** The parts of the CRE SDK's HTTP request and response this function uses. */
export type NodeHttpRequest = {
  url: string
  method: string
  multiHeaders: Record<string, { values: string[] }>
  timeout: string
  cacheSettings: { store: boolean }
}
export type NodeHttpResponse = { statusCode: number; body: Uint8Array }
export type NodeFetchDeps<Resp extends NodeHttpResponse> = {
  text: (resp: Resp) => string
  hashLexeme: (lexeme: string) => string // 0x-prefixed keccak256 of the UTF-8 bytes
}

/** Each DON node fetches and evaluates independently, returning "STATUS|valueHash|code" for identical consensus. */
export const nodeFetch =
  <Resp extends NodeHttpResponse>(deps: NodeFetchDeps<Resp>) =>
  (
    sendRequester: { sendRequest(req: NodeHttpRequest): { result(): Resp } },
    spec: FeedSpec,
    url: string,
    timeout: string,
    authHeader: string,
    authValue: string,
  ): string => {
    try {
      const multiHeaders: Record<string, { values: string[] }> = { accept: { values: ['application/json'] } }
      if (authHeader !== '') multiHeaders[authHeader] = { values: [authValue] }
      const resp = sendRequester
        .sendRequest({
          url,
          method: 'GET',
          multiHeaders,
          timeout,
          cacheSettings: { store: false }, // with maxAge unset, every node fetches fresh
        })
        .result()
      const bodyBytes = resp.body.length
      if (bodyBytes > MAX_BODY_BYTES) return 'ERROR|' + ZERO32 + '|BODY_TOO_LARGE'
      let ev = evaluateResponse(spec, resp.statusCode, deps.text(resp), bodyBytes)
      if (ev.code === 'SPORTS_CLASSIFICATION_REQUIRED') {
        const companionUrl = sportsCompanionUrl(spec)
        if (!companionUrl) return 'ERROR|' + ZERO32 + '|SPORTS_SPEC_INVALID'
        const other = sendRequester.sendRequest({ url: companionUrl, method: 'GET', multiHeaders, timeout, cacheSettings: { store: false } }).result()
        if (other.body.length > MAX_BODY_BYTES) return 'ERROR|' + ZERO32 + '|BODY_TOO_LARGE'
        ev = evaluateResponse(spec, resp.statusCode, deps.text(resp), bodyBytes,
          { statusCode: other.statusCode, body: deps.text(other), bodyBytes: other.body.length })
      }
      const vh = ev.status === 'YES' || ev.status === 'NO' ? deps.hashLexeme(ev.valueLexeme) : ZERO32
      return `${ev.status}|${vh}|${ev.code}`
    } catch {
      return 'ERROR|' + ZERO32 + '|FETCH_FAILED' // timeout, 429, body over 250 KB, ...
    }
  }
