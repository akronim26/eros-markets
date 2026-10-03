// Task O33.1: one panel model, asked once (plan §8.3). Temperature 0 and seed 0 where the API takes them (the
// provider table in oracle-sdk), the answer schema sent where the provider enforces it and checked here always.
// Failures: a network error, a timeout, HTTP 429 or 5xx, an answer cut off or empty, or invalid output are retried
// up to 3 times with back-off (the provider's Retry-After, else 5 s, 15 s, 45 s); then the model ABSTAINs. A missing
// key or another 4xx cannot succeed on retry and ABSTAINs at once. A valid answer whose citations fail
// (`checkCitations`) is ABSTAIN too. Every attempt is recorded for the evidence log.
import { KEYS, modelIdHash, modelRequest, parseModel, responseText, retryDelayMs, type ModelCall } from '@eros-oracle/oracle-sdk'
import type { Item } from '@eros-oracle/snapshotter'
import type { Hex } from 'viem'
import { ANSWER_SCHEMA, type Answer, checkCitations, InvalidAnswer, type Label, PANEL_LABEL, parseAnswer } from './answer'

export const MAX_RETRIES = 3
export const CALL_TIMEOUT_MS = 300_000 // thinking models can take minutes

export type AbstainReason = 'API_FAILURE' | 'NO_VALID_CITATION' | 'ONLY_CONTEXT_CITED'

/** One HTTP call: its status (0 when no response came), why it failed, and the provider's Retry-After if sent. */
export type Attempt = { httpStatus: number; error?: string; retryAfter?: string }

export type ModelOutcome = {
  model: string
  modelIdHash: Hex
  label: Label | 'ABSTAIN'
  /** The contract's PanelLabel code. */
  labelCode: number
  /** The model's own confidence; null when it gave no valid answer. Calibration (O33.3) maps it. */
  confidence: number | null
  /** Valid citations only. */
  cited: number[]
  rationale: string
  abstainReason?: AbstainReason
  /** The answer as the model gave it (for the evidence log), when it gave a valid one. */
  answer?: Answer
  attempts: Attempt[]
}

export type ClientDeps = {
  env?: Record<string, string | undefined>
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

/** A failure the next attempt may not repeat. */
class Retryable extends Error {
  constructor(message: string, readonly retryAfter: string | null = null) {
    super(message)
  }
}

export async function askModel(model: string, call: ModelCall, items: readonly Item[], deps: ClientDeps = {}): Promise<ModelOutcome> {
  const env = deps.env ?? process.env
  const fetchFn = deps.fetchFn ?? fetch
  const sleep = deps.sleep ?? Bun.sleep
  const id = modelIdHash(model)
  const attempts: Attempt[] = []
  const abstain = (reason: AbstainReason, answer?: Answer, cited: number[] = []): ModelOutcome => ({
    model, modelIdHash: id, label: 'ABSTAIN', labelCode: PANEL_LABEL.ABSTAIN, confidence: answer?.confidence ?? null, cited,
    rationale: answer?.rationale ?? '', abstainReason: reason, answer, attempts,
  })

  const { provider } = parseModel(model)
  const keyName = KEYS[provider]
  const key = keyName ? env[keyName] : undefined
  if (!key) {
    attempts.push({ httpStatus: 0, error: keyName ? `set ${keyName}` : `no client for provider "${provider}"` })
    return abstain('API_FAILURE')
  }
  const { url, init } = modelRequest(model, call, key, { schema: ANSWER_SCHEMA, seed: 0 })

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs(attempt - 1, lastRetryAfter(attempts)))
    let status = 0
    try {
      let res: Response
      try {
        res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? CALL_TIMEOUT_MS) })
      } catch (e) {
        throw new Retryable(e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : `network: ${e instanceof Error ? e.message : String(e)}`)
      }
      status = res.status
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300)
        if (status === 429 || status >= 500) throw new Retryable(`HTTP ${status} ${body}`, res.headers.get('retry-after'))
        attempts.push({ httpStatus: status, error: `HTTP ${status} ${body}` })
        return abstain('API_FAILURE') // another 4xx (bad key, bad request) will not change on retry
      }
      let answer: Answer
      try {
        answer = parseAnswer(responseText(provider, await res.json()))
      } catch (e) {
        throw new Retryable(e instanceof InvalidAnswer ? `invalid output: ${e.message}` : e instanceof Error ? e.message : String(e))
      }
      attempts.push({ httpStatus: status })
      const c = checkCitations(answer.cited, items)
      if (c.reason) return abstain(c.reason, answer, c.valid)
      return {
        model, modelIdHash: id, label: answer.label, labelCode: PANEL_LABEL[answer.label], confidence: answer.confidence, cited: c.valid,
        rationale: answer.rationale, answer, attempts,
      }
    } catch (e) {
      if (!(e instanceof Retryable)) throw e
      attempts.push({ httpStatus: status, error: e.message, ...(e.retryAfter !== null ? { retryAfter: e.retryAfter } : {}) })
    }
  }
  return abstain('API_FAILURE')
}

const lastRetryAfter = (attempts: Attempt[]): string | null => attempts.at(-1)?.retryAfter ?? null
