// Model calls are scripted doubles; the HTTP clients are checked for request shapes, parsing and retries.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, toBytes } from 'viem'
import { ambiguity, ambiguityPrompt, ANSWER_RETRIES, applyTriage, parseUndecided, PROMPT_PATH } from '../src/ambiguity'
import { list } from '../src/list'
import { type CallModel, httpModelClient, type ModelCall, modelRequest, responseText, retryDelayMs, temperatureFor } from '../src/models'

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url))
const sample = JSON.parse(readFileSync(join(FIX, 'sample-listing.json'), 'utf8'))
const MODELS = ['anthropic:claude-test@2026-01-01', 'openai:gpt-test@2026-01-01', 'google:gemini-test@2026-01-01']
const ZERO32 = `0x${'00'.repeat(32)}`
const FORGE = 120_000
const NONE = '{"undecided": []}'

async function packFor(edit: (l: any) => void = () => {}) {
  const l = structuredClone(sample)
  l.ambiguity = { models: MODELS }
  l.marketInput.ai.modelIdHashes = MODELS.map((m) => keccak256(toBytes(m)))
  edit(l)
  const out = mkdtempSync(join(tmpdir(), 'oracle-cli-'))
  const input = join(out, 'listing.json')
  writeFileSync(input, JSON.stringify(l))
  const r = await list({ input, out, referenceFile: join(FIX, 'reference-final.json'), oracle: '0x' + 'aa'.repeat(20), check: false })
  return { input, out, dir: r.dir }
}
const answers = (byModel: Record<string, string>): CallModel => async (m) => byModel[m] ?? NONE

describe('ambiguity', () => {
  test('no undecided case: PASS, ambiguity.log written, pack.json ambiguityLogHash = keccak256 of the log', async () => {
    const { input, out, dir } = await packFor()
    const before = readFileSync(join(dir, 'pack.json'), 'utf8')
    const calls: { model: string; call: ModelCall }[] = []
    const callModel: CallModel = async (model, call) => { calls.push({ model, call }); return NONE }
    const r = await ambiguity({ input, out, callModel, now: () => new Date('2026-10-03T00:00:00Z') })
    expect(r.pass).toBe(true)
    const logBytes = readFileSync(join(dir, 'ambiguity.log'))
    expect(r.ambiguityLogHash).toBe(keccak256(new Uint8Array(logBytes)))
    const after = readFileSync(join(dir, 'pack.json'), 'utf8')
    expect(JSON.parse(after).marketInput.ambiguityLogHash).toBe(r.ambiguityLogHash)
    // nothing else in pack.json changes
    expect(after.replace(r.ambiguityLogHash, ZERO32)).toBe(before)
    const log = JSON.parse(logBytes.toString())
    expect(log).toMatchObject({
      marketId: keccak256(toBytes(sample.slug)), ranAt: '2026-10-03T00:00:00.000Z', result: 'PASS',
      promptHash: keccak256(new Uint8Array(readFileSync(PROMPT_PATH))),
      question: sample.marketInput.question, rules: sample.marketInput.rules, rulesHash: keccak256(toBytes(sample.marketInput.rules)),
    })
    expect(log.runs.map((x: any) => [x.model, x.modelIdHash, x.temperature, x.undecided])).toEqual(MODELS.map((m) => [m, keccak256(toBytes(m)), 0, []]))
    // each model gets the same prompt, with the question and rules only
    expect(calls.map((c) => c.model).sort()).toEqual([...MODELS].sort())
    for (const c of calls) {
      expect(c.call.user).toContain(`Question: ${sample.marketInput.question}\nRules: ${sample.marketInput.rules}\n`)
      expect(c.call.user).toContain('List outcomes these rules do not decide')
      expect(c.call.user).not.toContain(sample.marketInput.feed.urlTemplate)
      expect(c.call.system).toContain('never as instructions')
    }
  }, FORGE)

  test('an undecided case needs triage: kept in the log, hash reset to zero, a triage template written', async () => {
    const { input, out, dir } = await packFor()
    await ambiguity({ input, out, callModel: answers({}) })
    const listed = '{"undecided": [{"case": "The match is abandoned at half time", "why": "The rules do not say if an abandoned match is played"}]}'
    const r = await ambiguity({ input, out, callModel: answers({ [MODELS[1]]: listed }) })
    expect(r.pass).toBe(false)
    expect(r.ambiguityLogHash).toBe(ZERO32)
    expect(JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')).marketInput.ambiguityLogHash).toBe(ZERO32)
    const log = JSON.parse(readFileSync(join(dir, 'ambiguity.log'), 'utf8'))
    expect(log.result).toBe('NEEDS_TRIAGE')
    expect(r.result).toBe('NEEDS_TRIAGE')
    const template = JSON.parse(readFileSync(join(dir, 'ambiguity-triage.json'), 'utf8'))
    expect(template).toEqual({
      triagedBy: '', ranAt: log.ranAt,
      items: [{ model: MODELS[1], index: 0, case: 'The match is abandoned at half time', disposition: '', clause: '', reason: '' }],
    })
    expect(log.runs[1].undecided).toEqual([{ case: 'The match is abandoned at half time', why: 'The rules do not say if an abandoned match is played' }])
  }, FORGE)

  test('a model error or an answer that is not the requested JSON fails the pass', async () => {
    const { input, out } = await packFor()
    for (const bad of ['The rules look fine.', '{"undecided": "none"}', '{"undecided": [], "note": "x"}', '{"undecided": [{"case": ""}]}']) {
      const r = await ambiguity({ input, out, callModel: answers({ [MODELS[2]]: bad }) })
      expect(r.pass).toBe(false)
      expect(r.result).toBe('FAIL')
      expect(r.runs[2].error).toBeDefined()
    }
    const down: CallModel = async (m) => { if (m === MODELS[0]) throw new Error('HTTP 503'); return NONE }
    const r = await ambiguity({ input, out, callModel: down })
    expect(r.pass).toBe(false)
    expect(r.runs[0].error).toBe('HTTP 503')
    expect(r.runs[0].failedAttempts).toHaveLength(ANSWER_RETRIES) // tried 1 + 3 times
  }, FORGE)

  test('an empty or garbled answer is retried and recorded; a later valid answer counts', async () => {
    const { input, out } = await packFor()
    const seq = ['!!!!!!!!', '', NONE]
    let n = 0
    const flaky: CallModel = async (m) => {
      if (m !== MODELS[1]) return NONE
      const a = seq[n++]
      if (a === '') throw new Error('empty response from nvidia')
      return a
    }
    const r = await ambiguity({ input, out, callModel: flaky })
    expect(r.result).toBe('PASS')
    expect(r.runs[1].error).toBeUndefined()
    expect(r.runs[1].failedAttempts!.map((f) => f.error)).toEqual([expect.stringMatching(/JSON|undecided/i), 'empty response from nvidia'])
    expect(r.runs[1].failedAttempts![0].response).toBe('!!!!!!!!')
    expect(n).toBe(3)
  }, FORGE)

  test('models must be the ones ai.modelIdHashes names, in order', async () => {
    const { input, out } = await packFor((l) => (l.ambiguity.models = [MODELS[1], MODELS[0], MODELS[2]]))
    await expect(ambiguity({ input, out, callModel: answers({}) })).rejects.toThrow(/ambiguity.models\[0\] .* is not ai.modelIdHashes\[0\]/)
  }, FORGE)

  test('a pack built from other rules is refused', async () => {
    const { input, out } = await packFor()
    const l = JSON.parse(readFileSync(input, 'utf8'))
    l.marketInput.rules += ' Edited.'
    writeFileSync(input, JSON.stringify(l))
    await expect(ambiguity({ input, out, callModel: answers({}) })).rejects.toThrow(/re-run oracle-cli list/)
  }, FORGE)
})

describe('triage (ADJ-37)', () => {
  const twoCases = '{"undecided": [{"case": "Abandoned at half time", "why": "unclear"}, {"case": "Score written as 02", "why": "format"}]}'
  const oneCase = '{"undecided": [{"case": "Match moved to a cup tie", "why": "competition"}]}'

  /** A pack whose pass is NEEDS_TRIAGE: model 1 lists two cases, model 3 one. */
  async function needsTriage() {
    const p = await packFor()
    await ambiguity({ ...p, callModel: answers({ [MODELS[0]]: twoCases, [MODELS[2]]: oneCase }), now: () => new Date('2026-10-03T00:00:00Z') })
    return p
  }
  const ruleQuote = 'INVALID' // a word the sample rules contain
  function triageFile(dir: string, edit: (t: any) => void = () => {}) {
    const t = JSON.parse(readFileSync(join(dir, 'ambiguity-triage.json'), 'utf8'))
    t.triagedBy = 'xipharis'
    t.items[0] = { ...t.items[0], disposition: 'decided', clause: ruleQuote, reason: 'the rules make an unplayed match INVALID' }
    t.items[1] = { ...t.items[1], disposition: 'immaterial', reason: 'the source returns JSON numbers' }
    t.items[2] = { ...t.items[2], disposition: 'immaterial', reason: 'a league fixture is not moved to a cup' }
    delete t.items[1].clause
    edit(t)
    const path = join(dir, 'triage.json')
    writeFileSync(path, JSON.stringify(t))
    return path
  }

  test('a complete triage passes: the log records it, and the hash commits to answers and triage', async () => {
    const { input, out, dir } = await needsTriage()
    const before = JSON.parse(readFileSync(join(dir, 'ambiguity.log'), 'utf8'))
    const r = applyTriage({ input, out, triage: triageFile(dir), now: () => new Date('2026-10-03T01:00:00Z') })
    expect(r.result).toBe('PASS_TRIAGED')
    const logBytes = readFileSync(join(dir, 'ambiguity.log'))
    expect(r.ambiguityLogHash).toBe(keccak256(new Uint8Array(logBytes)))
    expect(JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')).marketInput.ambiguityLogHash).toBe(r.ambiguityLogHash)
    const log = JSON.parse(logBytes.toString())
    expect(log.runs).toEqual(before.runs) // the models' answers are kept unchanged
    expect(log.result).toBe('PASS_TRIAGED')
    expect(log.triage.triagedBy).toBe('xipharis')
    expect(log.triage.triagedAt).toBe('2026-10-03T01:00:00.000Z')
    expect(log.triage.items.map((i: any) => [i.model, i.index, i.disposition])).toEqual([
      [MODELS[0], 0, 'decided'], [MODELS[0], 1, 'immaterial'], [MODELS[2], 0, 'immaterial'],
    ])
    expect(log.triage.items[1].clause).toBeUndefined()
  }, FORGE)

  test('an incomplete or wrong triage is rejected with every problem listed, and nothing changes', async () => {
    const { input, out, dir } = await needsTriage()
    const logBefore = readFileSync(join(dir, 'ambiguity.log'), 'utf8')
    const packBefore = readFileSync(join(dir, 'pack.json'), 'utf8')
    const bad: [(t: any) => void, RegExp][] = [
      [(t) => t.items.pop(), /#0 has no disposition/],
      [(t) => (t.items[0].clause = 'a clause the rules do not contain'), /"decided" needs a clause quoted exactly from the rules/],
      [(t) => (t.items[1].disposition = 'fixed'), /disposition must be "decided" or "immaterial"/],
      [(t) => (t.items[2].reason = ' '), /no reason/],
      [(t) => (t.items[2].case = 'another case'), /case text differs/],
      [(t) => t.items.push({ ...t.items[2], index: 5 }), /#5 is not a case in the log/],
      [(t) => (t.triagedBy = ''), /triagedBy is empty/],
      [(t) => (t.ranAt = '2026-01-01T00:00:00.000Z'), /the triage is for the pass of/],
    ]
    for (const [edit, msg] of bad) expect(() => applyTriage({ input, out, triage: triageFile(dir, edit) })).toThrow(msg)
    expect(readFileSync(join(dir, 'ambiguity.log'), 'utf8')).toBe(logBefore)
    expect(readFileSync(join(dir, 'pack.json'), 'utf8')).toBe(packBefore)
  }, FORGE)

  test('only a NEEDS_TRIAGE pass for the current rules can be triaged', async () => {
    const p = await packFor()
    await ambiguity({ ...p, callModel: answers({ [MODELS[1]]: 'not JSON' }) }) // FAIL: a model did not answer
    expect(() => applyTriage({ ...p, triage: join(p.dir, 'none.json') })).toThrow(/ambiguity.log is FAIL/)
    const q = await needsTriage()
    const t = triageFile(q.dir)
    const l = JSON.parse(readFileSync(q.input, 'utf8'))
    l.marketInput.rules += ' Edited.'
    writeFileSync(q.input, JSON.stringify(l))
    expect(() => applyTriage({ input: q.input, out: q.out, triage: t })).toThrow(/re-run oracle-cli list/)
  }, FORGE)
})

describe('prompt and answer', () => {
  test('LF and CRLF prompt checkouts produce the same call while inserted user text stays literal', () => {
    const lf = 'SYSTEM\nReview the rules.\n\nUSER\nQuestion: {{QUESTION}}\nRules: {{RULES}}\n'
    const question = 'First line\r\nSecond $& line', rules = 'Literal $1 rules'
    const expected = { system: 'Review the rules.', user: `Question: ${question}\nRules: ${rules}` }
    expect(ambiguityPrompt(lf, question, rules)).toEqual(expected)
    expect(ambiguityPrompt(lf.replaceAll('\n', '\r\n'), question, rules)).toEqual(expected)
  })

  test('the prompt substitutes the text literally ($ patterns included)', () => {
    const p = ambiguityPrompt(readFileSync(PROMPT_PATH, 'utf8'), 'Q $& $1?', 'R $` $\'.')
    expect(p.user).toContain("Question: Q $& $1?\nRules: R $` $'.\n")
    expect(p.system.startsWith('You review the rules')).toBe(true)
  })

  test('a fenced JSON answer is accepted', () => {
    expect(parseUndecided('```json\n{"undecided": []}\n```')).toEqual([])
  })
})

describe('model clients', () => {
  const call = { system: 'S', user: 'U' }

  test('request shapes per provider; the API model is the id between ":" and "@"', () => {
    const a = modelRequest('anthropic:claude-x@v1', call, 'k')
    expect(a.url).toBe('https://api.anthropic.com/v1/messages')
    expect(a.init.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
    expect(JSON.parse(a.init.body as string)).toEqual({ model: 'claude-x', max_tokens: 8192, temperature: 0, system: 'S', messages: [{ role: 'user', content: 'U' }] })
    const o = modelRequest('openai:gpt-x@v1', call, 'k')
    expect(o.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(o.init.headers).toMatchObject({ authorization: 'Bearer k' })
    expect(JSON.parse(o.init.body as string)).toMatchObject({ model: 'gpt-x', temperature: 0, seed: 0, max_completion_tokens: 8192, response_format: { type: 'json_object' } })
    const g = modelRequest('google:gemini-x@v1', call, 'k')
    expect(g.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent')
    expect(JSON.parse(g.init.body as string).generationConfig).toEqual({ temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 32768 })
    const q = modelRequest('groq:openai/gpt-oss-120b@2026-10-03', call, 'k')
    expect(q.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(q.init.headers).toMatchObject({ authorization: 'Bearer k' })
    expect(JSON.parse(q.init.body as string)).toEqual({
      model: 'openai/gpt-oss-120b', temperature: 0, seed: 0, max_completion_tokens: 6000, // no JSON mode on Groq (json_validate_failed on gpt-oss)
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    })
    const m = modelRequest('mistral:mistral-large-latest@2026-10-03', call, 'k')
    expect(m.url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(JSON.parse(m.init.body as string)).toEqual({
      model: 'mistral-large-latest', temperature: 0, random_seed: 0, max_tokens: 8192, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    })
    const c = modelRequest('cerebras:qwen-3.8-27b@2026-10-03', call, 'k')
    expect(c.url).toBe('https://api.cerebras.ai/v1/chat/completions')
    expect(c.init.headers).toMatchObject({ authorization: 'Bearer k' })
    expect(JSON.parse(c.init.body as string)).toEqual({
      model: 'qwen-3.8-27b', temperature: 0, seed: 0, max_completion_tokens: 4096, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    })
    const n = modelRequest('nvidia:moonshotai/kimi-k2.5@2026-10-03', call, 'k')
    expect(n.url).toBe('https://integrate.api.nvidia.com/v1/chat/completions')
    expect(n.init.headers).toMatchObject({ authorization: 'Bearer k' })
    expect(JSON.parse(n.init.body as string)).toEqual({
      model: 'moonshotai/kimi-k2.5', temperature: 0, seed: 0, max_tokens: 8192,
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    })
    const ac = modelRequest('aicredits:google/gemini-3.8-flash@2026-10-04', call, 'k')
    expect(ac.url).toBe('https://api.aicredits.in/v1/chat/completions')
    expect(ac.init.headers).toMatchObject({ authorization: 'Bearer k' })
    expect(JSON.parse(ac.init.body as string)).toEqual({
      model: 'google/gemini-3.8-flash', temperature: 0, seed: 0, max_tokens: 32768,
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    })
    // Kimi K3 degenerates at temperature 0; it runs at its recommended 1.0, every other model at 0
    expect(JSON.parse(modelRequest('nvidia:moonshotai/kimi-k3@2026-10-03', call, 'k').init.body as string).temperature).toBe(1)
    expect(temperatureFor('nvidia:moonshotai/kimi-k3@2026-10-03')).toBe(1)
    expect(temperatureFor('groq:openai/gpt-oss-120b@2026-10-03')).toBe(0)
    expect(() => modelRequest('cohere:c@1', call, 'k')).toThrow(/no client for provider "cohere" \(anthropic, openai, google, groq, mistral, cerebras, nvidia, aicredits\)/)
  })

  test('response text per provider', () => {
    expect(responseText('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab')
    expect(responseText('openai', { choices: [{ message: { content: 'o' } }] })).toBe('o')
    expect(responseText('google', { candidates: [{ content: { parts: [{ text: 'g' }] } }] })).toBe('g')
    expect(responseText('groq', { choices: [{ message: { content: 'q' } }] })).toBe('q')
    expect(responseText('mistral', { choices: [{ message: { content: 'm' } }] })).toBe('m')
    expect(responseText('cerebras', { choices: [{ message: { content: 'c' } }] })).toBe('c')
    expect(() => responseText('openai', { choices: [] })).toThrow(/empty response/)
    // a cut-off answer is an error (gpt-oss on Groq ran out of tokens mid-JSON in the first live run)
    expect(() => responseText('groq', { choices: [{ message: { content: '{"undecided": [' }, finish_reason: 'length' }] })).toThrow(/cut off/)
    expect(() => responseText('anthropic', { content: [{ type: 'text', text: '{' }], stop_reason: 'max_tokens' })).toThrow(/cut off/)
    expect(() => responseText('google', { candidates: [{ content: { parts: [{ text: '{' }] }, finishReason: 'MAX_TOKENS' }] })).toThrow(/cut off/)
    expect(responseText('groq', { choices: [{ message: { content: 'q' }, finish_reason: 'stop' }] })).toBe('q')
  })

  test('retries 429 and 5xx with back-off, then gives up; a missing key is an error', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number) => { sleeps.push(ms) }
    let n = 0
    const flaky = (async () => (n++ < 2 ? new Response('busy', { status: 429 }) : Response.json({ choices: [{ message: { content: NONE } }] }))) as unknown as typeof fetch
    expect(await httpModelClient({ OPENAI_API_KEY: 'k' }, flaky, sleep)('openai:gpt-x@1', call)).toBe(NONE)
    expect(sleeps).toEqual([5000, 15000])
    const down = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    sleeps.length = 0
    await expect(httpModelClient({ OPENAI_API_KEY: 'k' }, down, sleep)('openai:gpt-x@1', call)).rejects.toThrow(/HTTP 503/)
    expect(sleeps).toEqual([5000, 15000, 45000]) // three retries, then the error
    sleeps.length = 0
    let m = 0
    const throttled = (async () => (m++ < 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : Response.json({ choices: [{ message: { content: NONE } }] }))) as unknown as typeof fetch
    expect(await httpModelClient({ MISTRAL_API_KEY: 'k' }, throttled, sleep)('mistral:m@1', call)).toBe(NONE)
    expect(sleeps).toEqual([7000]) // the provider's Retry-After
    expect(retryDelayMs(2, '600')).toBe(60_000) // capped
    expect(retryDelayMs(0, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe(5000) // a date is not used
    const bad = (async () => new Response('no', { status: 400 })) as unknown as typeof fetch
    await expect(httpModelClient({ GEMINI_API_KEY: 'k' }, bad, sleep)('google:g@1', call)).rejects.toThrow(/HTTP 400/)
    await expect(httpModelClient({}, down, sleep)('anthropic:c@1', call)).rejects.toThrow(/set ANTHROPIC_API_KEY/)
    await expect(httpModelClient({}, down, sleep)('groq:g@1', call)).rejects.toThrow(/set GROQ_API_KEY/)
    await expect(httpModelClient({}, down, sleep)('mistral:m@1', call)).rejects.toThrow(/set MISTRAL_API_KEY/)
    await expect(httpModelClient({}, down, sleep)('cerebras:q@1', call)).rejects.toThrow(/set CEREBRAS_API_KEY/)
    await expect(httpModelClient({}, down, sleep)('nvidia:k@1', call)).rejects.toThrow(/set NVIDIA_API_KEY/)
  })
})
