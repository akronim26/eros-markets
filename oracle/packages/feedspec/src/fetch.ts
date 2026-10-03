// Node-mode fetch shared by workflows/resolution and workflows/dryrun (plan §7.5: "same fetch, evaluator and
// identical consensus"). It lives here, with no package imports, because each workflow is a standalone package
// with its own node_modules (ADJ-10): a bare import from a file outside the workflow would resolve to another
// copy of the SDK. The workflow passes in its own SDK `text` and its own keccak (ADJ-36).
import { evaluateResponse, type FeedSpec, MAX_BODY_BYTES } from './index'

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
  text: (resp: Resp) => string // the SDK's `text` (UTF-8 decode, trimmed)
  hashLexeme: (lexeme: string) => string // keccak256 of the lexeme's UTF-8 bytes, 0x-prefixed
}

/**
 * Returns the node-mode function: each DON node fetches and evaluates independently and returns
 * "STATUS|valueHash|code", the string identical consensus agrees on.
 */
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
          cacheSettings: { store: false }, // maxAge unset (0) => never read from cache; fresh per node
        })
        .result()
      const bodyBytes = resp.body.length
      if (bodyBytes > MAX_BODY_BYTES) return 'ERROR|' + ZERO32 + '|BODY_TOO_LARGE'
      const ev = evaluateResponse(spec, resp.statusCode, deps.text(resp), bodyBytes)
      const vh = ev.status === 'YES' || ev.status === 'NO' ? deps.hashLexeme(ev.valueLexeme) : ZERO32
      return `${ev.status}|${vh}|${ev.code}`
    } catch {
      return 'ERROR|' + ZERO32 + '|FETCH_FAILED' // timeout, 429 throttling at transport, >250KB, etc.
    }
  }
