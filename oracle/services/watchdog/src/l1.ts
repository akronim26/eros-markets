// Task O35.1: the Layer 1 re-run (plan §9.2). The watchdog fetches the market's FeedSpec URL from its own egress and
// evaluates the body with the shared evaluator (packages/feedspec, the one the CRE workflow uses), then does the same
// for a fallback source when the watchdog's configuration lists one for the market (ADJ-44: the plan names a fallback
// source but nothing onchain or in the listing pack holds one). The result is a signal per source; `combine` makes the
// verdict.
import { buildUrl, EvalError, type Evaluation, evaluateResponse, type FeedSpec } from '@eros-oracle/feedspec'
import { type Hex, keccak256, stringToBytes } from 'viem'
import { combine } from './verdict'
import { OUTCOME_NAME, type OutcomeName, type Proposal, type Signal, type Verdict, type WatchdogChain } from './types'

export const FETCH_TIMEOUT_MS = 15_000
const ZERO32 = `0x${'00'.repeat(32)}`

/** The header and value for a FeedSpec's authRef, from the watchdog's own API keys; null when it has none. */
export type AuthFor = (authRef: string) => { header: string; value: string } | null

export type L1Deps = {
  fetchFn?: typeof fetch
  auth?: AuthFor
  /** Fallback FeedSpecs by market id (lowercase), from the watchdog's configuration. */
  fallbacks?: Record<string, FeedSpec>
  timeoutMs?: number
}

export type FeedResult = Evaluation & { url: string }

/** One GET of the spec's URL and the shared evaluation of the body; never throws. */
export async function evaluateFeed(spec: FeedSpec, deps: L1Deps = {}): Promise<FeedResult> {
  let url = ''
  try {
    url = buildUrl(spec)
  } catch (e) {
    return { status: 'ERROR', code: e instanceof EvalError ? e.code : 'BAD_URL', valueLexeme: '', url }
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  if (spec.authRef.toLowerCase() !== ZERO32) {
    const a = deps.auth?.(spec.authRef)
    if (!a) return { status: 'ERROR', code: 'NO_CREDENTIALS', valueLexeme: '', url }
    headers[a.header] = a.value
  }
  try {
    const res = await (deps.fetchFn ?? fetch)(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS) })
    const bytes = new Uint8Array(await res.arrayBuffer())
    // as the CRE SDK's `text`: UTF-8 decoded and trimmed; the evaluator refuses a body over MAX_BODY_BYTES
    return { ...evaluateResponse(spec, res.status, new TextDecoder().decode(bytes).trim(), bytes.length), url }
  } catch {
    return { status: 'ERROR', code: 'FETCH_FAILED', valueLexeme: '', url }
  }
}

export function feedSignal(source: 'L1' | 'FALLBACK', r: FeedResult): Signal {
  const outcome: OutcomeName | null = r.status === 'YES' || r.status === 'NO' ? r.status : null
  return { source, outcome, detail: `${r.url}: ${r.status} ${r.code}${r.valueLexeme ? ` value ${r.valueLexeme}` : ''}` }
}

/** The feed signals for a market: its FeedSpec, then the configured fallback if any. */
export async function feedSignals(id: Hex, chain: WatchdogChain, deps: L1Deps = {}): Promise<{ signals: Signal[]; primary: FeedResult }> {
  const primary = await evaluateFeed(await chain.feedSpec(id), deps)
  const signals = [feedSignal('L1', primary)]
  const fb = deps.fallbacks?.[id.toLowerCase()]
  if (fb) signals.push(feedSignal('FALLBACK', await evaluateFeed(fb, deps)))
  return { signals, primary }
}

/** The verdict on a Layer 1 proposal. A differing value hash with the same outcome is noted, not decisive. */
export async function checkL1(p: Proposal, chain: WatchdogChain, deps: L1Deps = {}): Promise<Verdict> {
  const { signals, primary } = await feedSignals(p.marketId, chain, deps)
  const v = combine(OUTCOME_NAME[p.outcome] as OutcomeName, signals)
  if ((primary.status === 'YES' || primary.status === 'NO') && p.valueHash && keccak256(stringToBytes(primary.valueLexeme)) !== p.valueHash.toLowerCase()) {
    return { ...v, reason: `${v.reason}; the value now (${primary.valueLexeme}) differs from the one reported` }
  }
  return v
}
