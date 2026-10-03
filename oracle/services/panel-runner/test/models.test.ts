// Task O33.1: the panel's model clients against provider responses (test/fixtures/responses, see its README; and any
// recorded under test/fixtures/recorded). A scripted fetch replays them, so each failure path of plan §8.3 is
// exercised: retries with back-off, then ABSTAIN; invalid output as an API failure; citations; independence.
import { KEYS, modelIdHash, type ModelCall, parseModel } from '@eros-oracle/oracle-sdk'
import type { Item } from '@eros-oracle/snapshotter'
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256, stringToBytes } from 'viem'
import { checkCitations, InvalidAnswer, parseAnswer, RATIONALE_MAX_CHARS } from '../src/models/answer'
import { askModel, type ClientDeps } from '../src/models/client'
import { askPanel, checkPanel, PanelConfigError } from '../src/models/panel'

const FIX = new URL('./fixtures/', import.meta.url).pathname
type Fixture = { httpStatus: number; headers: Record<string, string>; body: unknown }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(FIX, 'responses', `${name}.json`), 'utf8'))
const respond = (f: Fixture) => new Response(typeof f.body === 'string' ? f.body : JSON.stringify(f.body), { status: f.httpStatus, headers: f.headers })
/** An OpenAI-compatible success whose message content is `content`. */
const chat = (content: string): Fixture => {
  const f = fixture('openai-ok')
  ;(f.body as any).choices[0].message.content = content
  return f
}

const ANTHROPIC = 'anthropic:claude-x@2026-01-01'
const OPENAI = 'openai:gpt-x@2026-01-01'
const GROQ = 'groq:openai/gpt-oss-120b@2025-08-05'
const GOOGLE = 'google:gemini-x@001'
const ENV = { ANTHROPIC_API_KEY: 'ak', OPENAI_API_KEY: 'ok', GROQ_API_KEY: 'gk', GEMINI_API_KEY: 'gem' }
const CALL: ModelCall = { system: 'judge the market', user: 'the market and its evidence' }

const item = (allowListed: boolean, httpStatus = 200): Item => ({
  url: 'https://x/', host: 'x', allowListed, fetchedAt: 1, httpStatus, contentType: 'text/plain', sha256: '', bytesBase64: 'eA==', truncated: false,
})
const ITEMS = [item(true), item(true), item(false), item(true, 0)] // 2: context, 3: a fetch with no response

/** A fetch that answers each call with the next response (or throws it), recording requests and sleeps. */
function scripted(...replies: (Fixture | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const requests: { url: string; init: RequestInit; body: any }[] = []
  const sleeps: number[] = []
  let i = 0
  const fetchFn = (async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(init.body as string) })
    const r = replies[i++]
    if (r === undefined) throw new Error(`unexpected call ${i}`)
    if (r instanceof Error) throw r
    if (typeof r === 'function') return r(init)
    return respond(r)
  }) as unknown as typeof fetch
  const deps: ClientDeps = { env: ENV, fetchFn, sleep: async (ms) => void sleeps.push(ms) }
  return { deps, requests, sleeps }
}

describe('answer schema', () => {
  const ok = { label: 'NO', confidence: 0.5, cited: [1, 0, 1], rationale: 'r' }
  test('a valid answer, plain or in one ```json fence; duplicate citations once', () => {
    expect(parseAnswer(JSON.stringify(ok))).toEqual({ label: 'NO', confidence: 0.5, cited: [1, 0], rationale: 'r' })
    expect(parseAnswer('```json\n' + JSON.stringify(ok) + '\n```')).toEqual(parseAnswer(JSON.stringify(ok)))
    expect(parseAnswer(JSON.stringify({ ...ok, confidence: 0 })).confidence).toBe(0)
    expect(parseAnswer(JSON.stringify({ ...ok, confidence: 1, label: 'NOT_YET' })).label).toBe('NOT_YET')
    expect(parseAnswer(JSON.stringify({ ...ok, rationale: 'é'.repeat(RATIONALE_MAX_CHARS) })).rationale.length).toBe(1000)
  })

  test.each([
    ['not JSON', 'The answer is YES.'],
    ['text around the JSON', 'Sure! ' + JSON.stringify(ok)],
    ['an array', '[]'],
    ['a missing key', JSON.stringify({ label: 'YES', confidence: 0.5, cited: [0] })],
    ['an extra key', JSON.stringify({ ...ok, notes: 'x' })],
    ['ABSTAIN as a label', JSON.stringify({ ...ok, label: 'ABSTAIN' })],
    ['a lowercase label', JSON.stringify({ ...ok, label: 'yes' })],
    ['confidence above 1', JSON.stringify({ ...ok, confidence: 1.2 })],
    ['confidence below 0', JSON.stringify({ ...ok, confidence: -0.1 })],
    ['confidence as a string', JSON.stringify({ ...ok, confidence: '0.9' })],
    ['a fractional citation', JSON.stringify({ ...ok, cited: [0.5] })],
    ['a negative citation', JSON.stringify({ ...ok, cited: [-1] })],
    ['citations as strings', JSON.stringify({ ...ok, cited: ['0'] })],
    ['a rationale over 1,000 characters', JSON.stringify({ ...ok, rationale: 'x'.repeat(RATIONALE_MAX_CHARS + 1) })],
  ])('invalid: %s', (_, text) => {
    expect(() => parseAnswer(text)).toThrow(InvalidAnswer)
  })
})

describe('citations', () => {
  test('valid: in range and the item has a response; reasons for none, and for context only', () => {
    expect(checkCitations([0, 2, 9], ITEMS)).toEqual({ valid: [0, 2] })
    expect(checkCitations([], ITEMS)).toEqual({ valid: [], reason: 'NO_VALID_CITATION' })
    expect(checkCitations([3, 4, 99], ITEMS)).toEqual({ valid: [], reason: 'NO_VALID_CITATION' }) // no response, out of range
    expect(checkCitations([2], ITEMS)).toEqual({ valid: [2], reason: 'ONLY_CONTEXT_CITED' })
  })
})

describe('one model', () => {
  test.each([
    [ANTHROPIC, 'anthropic-ok'],
    [OPENAI, 'openai-ok'],
    [GROQ, 'groq-ok'],
    [GOOGLE, 'google-ok'],
  ])('%s: a valid answer in one attempt', async (model, name) => {
    const s = scripted(fixture(name))
    const o = await askModel(model, CALL, ITEMS, s.deps)
    expect(o).toMatchObject({ model, modelIdHash: keccak256(stringToBytes(model)), label: 'YES', labelCode: 1, confidence: 0.93, cited: [0, 1] })
    expect(o.abstainReason).toBeUndefined()
    expect(o.attempts).toEqual([{ httpStatus: 200 }])
    expect(s.sleeps).toEqual([])
  })

  test('requests: temperature 0, seed 0 where the API takes one, the schema where the provider enforces it', async () => {
    const s = scripted(fixture('openai-ok'), fixture('google-ok'), fixture('anthropic-ok'), fixture('groq-ok'))
    for (const m of [OPENAI, GOOGLE, ANTHROPIC, GROQ]) await askModel(m, CALL, ITEMS, s.deps)
    const [openai, google, anthropic, groq] = s.requests
    expect(openai.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(openai.body).toMatchObject({ model: 'gpt-x', temperature: 0, seed: 0, response_format: { type: 'json_schema', json_schema: { name: 'panel_answer', strict: true } } })
    expect(openai.body.messages).toEqual([{ role: 'system', content: CALL.system }, { role: 'user', content: CALL.user }])
    expect(google.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent')
    expect(google.body.generationConfig).toMatchObject({ temperature: 0, seed: 0, responseMimeType: 'application/json' })
    expect(anthropic.body).toMatchObject({ model: 'claude-x', temperature: 0, system: CALL.system })
    expect(groq.body).toMatchObject({ model: 'openai/gpt-oss-120b', temperature: 0, seed: 0 })
    expect(groq.body.response_format).toBeUndefined() // Groq's JSON mode is off (oracle-sdk); the answer is checked here
    expect((openai.init.headers as Record<string, string>).authorization).toBe('Bearer ok')
  })

  test('429: waits the provider\'s Retry-After, then succeeds', async () => {
    const s = scripted(fixture('error-429'), fixture('openai-ok'))
    const o = await askModel(OPENAI, CALL, ITEMS, s.deps)
    expect(o.label).toBe('YES')
    expect(s.sleeps).toEqual([7000])
    expect(o.attempts.map((a) => a.httpStatus)).toEqual([429, 200])
  })

  test('5xx on every attempt: 3 retries with back-off 5 s, 15 s, 45 s, then ABSTAIN', async () => {
    const s = scripted(fixture('error-500'), fixture('error-503'), fixture('error-500'), fixture('error-500'))
    const o = await askModel(GOOGLE, CALL, ITEMS, s.deps)
    expect(o).toMatchObject({ label: 'ABSTAIN', labelCode: 0, confidence: null, cited: [], abstainReason: 'API_FAILURE' })
    expect(o.attempts.map((a) => a.httpStatus)).toEqual([500, 503, 500, 500])
    expect(s.sleeps).toEqual([5000, 15000, 45000])
  })

  test('invalid output counts as an API failure: retried, and ABSTAIN when it never becomes valid', async () => {
    const bad = chat('{"label": "MAYBE", "confidence": 0.5, "cited": [0], "rationale": "r"}')
    const good = await askModel(OPENAI, CALL, ITEMS, scripted(bad, fixture('openai-ok')).deps)
    expect(good.label).toBe('YES')
    expect(good.attempts[0].error).toStartWith('invalid output: label "MAYBE"')
    const s = scripted(bad, chat('not json'), chat('{}'), bad)
    const o = await askModel(OPENAI, CALL, ITEMS, s.deps)
    expect(o.abstainReason).toBe('API_FAILURE')
    expect(o.attempts.length).toBe(4)
    expect(o.attempts.every((a) => a.httpStatus === 200 && a.error?.startsWith('invalid output'))).toBe(true)
  })

  test('an answer cut off at the token limit, or empty, is retried', async () => {
    const s = scripted(fixture('google-max-tokens'), fixture('google-empty'), fixture('google-ok'))
    const o = await askModel(GOOGLE, CALL, ITEMS, s.deps)
    expect(o.label).toBe('YES')
    expect(o.attempts.map((a) => a.error)).toEqual(['google answer cut off at the output token limit', 'empty response from google', undefined])
    const a = await askModel(ANTHROPIC, CALL, ITEMS, scripted(fixture('anthropic-max-tokens'), fixture('anthropic-ok')).deps)
    expect(a.attempts.length).toBe(2)
  })

  test('a network error or a timeout is retried', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    const s = scripted(new TypeError('fetch failed'), hang, fixture('groq-ok'))
    const o = await askModel(GROQ, CALL, ITEMS, { ...s.deps, timeoutMs: 50 })
    expect(o.label).toBe('YES')
    expect(o.attempts.map((a) => a.error)).toEqual(['network: fetch failed', 'timeout', undefined])
  })

  test('401 (or any 4xx but 429): ABSTAIN at once, no retry', async () => {
    const s = scripted(fixture('error-401'))
    const o = await askModel(OPENAI, CALL, ITEMS, s.deps)
    expect(o.abstainReason).toBe('API_FAILURE')
    expect(o.attempts).toEqual([{ httpStatus: 401, error: expect.stringContaining('Invalid API Key') }])
    expect(s.sleeps).toEqual([])
  })

  test('no key, or no client for the provider: ABSTAIN without a call', async () => {
    const s = scripted()
    const o = await askModel(OPENAI, CALL, ITEMS, { ...s.deps, env: {} })
    expect(o).toMatchObject({ label: 'ABSTAIN', abstainReason: 'API_FAILURE', attempts: [{ httpStatus: 0, error: 'set OPENAI_API_KEY' }] })
    const p = await askModel('acme:m@1', CALL, ITEMS, s.deps)
    expect(p.attempts[0].error).toBe('no client for provider "acme"')
    expect(s.requests).toEqual([])
  })

  test('a valid answer with no valid citation, or citing only context, is ABSTAIN (the answer kept for the log)', async () => {
    const none = await askModel(OPENAI, CALL, ITEMS, scripted(chat('{"label":"YES","confidence":0.9,"cited":[3,7],"rationale":"r"}')).deps)
    expect(none).toMatchObject({ label: 'ABSTAIN', labelCode: 0, abstainReason: 'NO_VALID_CITATION', confidence: 0.9, cited: [] })
    expect(none.answer?.label).toBe('YES')
    const ctx = await askModel(OPENAI, CALL, ITEMS, scripted(chat('{"label":"NO","confidence":0.8,"cited":[2],"rationale":"r"}')).deps)
    expect(ctx).toMatchObject({ label: 'ABSTAIN', abstainReason: 'ONLY_CONTEXT_CITED', cited: [2] })
    const mixed = await askModel(OPENAI, CALL, ITEMS, scripted(chat('{"label":"NO","confidence":0.8,"cited":[2,1,9],"rationale":"r"}')).deps)
    expect(mixed).toMatchObject({ label: 'NO', labelCode: 2, cited: [2, 1] })
    expect(none.attempts.length).toBe(1) // a citation failure is the model's answer, not retried
  })
})

describe('the panel', () => {
  test('three models from three providers', () => {
    expect(() => checkPanel([OPENAI, GOOGLE])).toThrow(PanelConfigError)
    expect(() => checkPanel([OPENAI, GOOGLE, ANTHROPIC, GROQ])).toThrow(PanelConfigError)
    expect(() => checkPanel([OPENAI, 'openai:gpt-y@1', GOOGLE])).toThrow(PanelConfigError)
    expect(() => checkPanel([GROQ, GOOGLE, ANTHROPIC])).not.toThrow()
    expect(() => checkPanel(['groq-gpt-oss', GOOGLE, ANTHROPIC])).toThrow() // not provider:model-id@version
  })

  test('independent calls: concurrent, the same prompt only, and one failure does not touch the others', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const reply = (f: Fixture) => async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Bun.sleep(20)
      inFlight--
      return respond(f)
    }
    const byUrl: Record<string, () => Promise<Response>> = {
      'https://api.groq.com/openai/v1/chat/completions': reply(fixture('groq-ok')),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent': reply(fixture('error-401')),
      'https://api.anthropic.com/v1/messages': reply(fixture('anthropic-ok')),
    }
    const bodies: string[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      bodies.push(init.body as string)
      return byUrl[url]()
    }) as unknown as typeof fetch
    const out = await askPanel([GROQ, GOOGLE, ANTHROPIC], CALL, ITEMS, { env: ENV, fetchFn, sleep: async () => {} })
    expect(out.map((o) => [o.model, o.label])).toEqual([[GROQ, 'YES'], [GOOGLE, 'ABSTAIN'], [ANTHROPIC, 'YES']])
    expect(maxInFlight).toBe(3)
    for (const b of bodies) {
      expect(b).toContain(JSON.stringify(CALL.user).slice(1, -1))
      expect(b).not.toContain('rationale":"Item 0') // no model's answer reaches another
    }
  })

  test('modelIdHash is keccak256 of "provider:model-id@version"', () => {
    expect(modelIdHash(GROQ)).toBe(keccak256(stringToBytes('groq:openai/gpt-oss-120b@2025-08-05')))
  })
})

describe('recorded provider responses', () => {
  // Real responses from `bun run record` (3 Oct 2026; scripts/record.ts: two items, 0 allow-listed, 1 context). Each
  // is replayed for every attempt the client makes.
  const dir = join(FIX, 'recorded')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []
  const EXPECTED: Record<string, { label: string; cited?: number[]; confidence?: number; attempts: number; abstainReason?: string }> = {
    'google__gemini-3.8-flash.json': { label: 'YES', cited: [0, 1], confidence: 1, attempts: 1 },
    'google__gemini-3.8-flash.503.json': { label: 'ABSTAIN', abstainReason: 'API_FAILURE', attempts: 4 }, // "high demand", retried 3 times
    'groq__openai_gpt-oss-120b.json': { label: 'YES', cited: [0], confidence: 0.99, attempts: 1 },
    'nvidia__moonshotai_kimi-k3.json': { label: 'YES', cited: [0, 1], confidence: 0.99, attempts: 1 },
  }

  test('every recording has an expected outcome', () => {
    expect(files).toEqual(Object.keys(EXPECTED).sort())
  })

  for (const f of Object.keys(EXPECTED)) {
    test.skipIf(!files.includes(f))(`${f}: ${EXPECTED[f].label}`, async () => {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture & { model: string }
      const s = scripted(rec, rec, rec, rec)
      const o = await askModel(rec.model, CALL, [item(true), item(false)], { ...s.deps, env: { [KEYS[parseModel(rec.model).provider]]: 'x' } })
      const want = EXPECTED[f]
      expect(o.label).toBe(want.label as never)
      expect(o.attempts.length).toBe(want.attempts)
      if (want.cited) expect(o.cited).toEqual(want.cited)
      if (want.confidence !== undefined) expect(o.confidence).toBe(want.confidence)
      if (want.abstainReason) expect(o.abstainReason).toBe(want.abstainReason as never)
    })
  }
})
