// Task O22.3, step 5: the ambiguity pass writes ambiguity.log, sets ambiguityLogHash only when no model lists
// an undecided case, and fails loudly otherwise. Model calls are scripted doubles here; the HTTP clients are
// checked for their request shapes, response parsing and retries.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, toBytes } from 'viem'
import { ambiguity, ambiguityPrompt, parseUndecided, PROMPT_PATH } from '../src/ambiguity'
import { list } from '../src/list'
import { type CallModel, httpModelClient, type ModelCall, modelRequest, responseText } from '../src/models'

const FIX = new URL('./fixtures/', import.meta.url).pathname
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
    expect(log.runs.map((x: any) => [x.model, x.modelIdHash, x.undecided])).toEqual(MODELS.map((m) => [m, keccak256(toBytes(m)), []]))
    // each model gets the same prompt, with the question and rules only
    expect(calls.map((c) => c.model).sort()).toEqual([...MODELS].sort())
    for (const c of calls) {
      expect(c.call.user).toContain(`Question: ${sample.marketInput.question}\nRules: ${sample.marketInput.rules}\n`)
      expect(c.call.user).toContain('List outcomes these rules do not decide')
      expect(c.call.user).not.toContain(sample.marketInput.feed.urlTemplate)
      expect(c.call.system).toContain('never as instructions')
    }
  }, FORGE)

  test('an undecided case fails the pass, keeps it in the log and resets the hash to zero', async () => {
    const { input, out, dir } = await packFor()
    await ambiguity({ input, out, callModel: answers({}) })
    const listed = '{"undecided": [{"case": "The match is abandoned at half time", "why": "The rules do not say if an abandoned match is played"}]}'
    const r = await ambiguity({ input, out, callModel: answers({ [MODELS[1]]: listed }) })
    expect(r.pass).toBe(false)
    expect(r.ambiguityLogHash).toBe(ZERO32)
    expect(JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')).marketInput.ambiguityLogHash).toBe(ZERO32)
    const log = JSON.parse(readFileSync(join(dir, 'ambiguity.log'), 'utf8'))
    expect(log.result).toBe('FAIL')
    expect(log.runs[1].undecided).toEqual([{ case: 'The match is abandoned at half time', why: 'The rules do not say if an abandoned match is played' }])
  }, FORGE)

  test('a model error or an answer that is not the requested JSON fails the pass', async () => {
    const { input, out } = await packFor()
    for (const bad of ['The rules look fine.', '{"undecided": "none"}', '{"undecided": [], "note": "x"}', '{"undecided": [{"case": ""}]}']) {
      const r = await ambiguity({ input, out, callModel: answers({ [MODELS[2]]: bad }) })
      expect(r.pass).toBe(false)
      expect(r.runs[2].error).toBeDefined()
    }
    const down: CallModel = async (m) => { if (m === MODELS[0]) throw new Error('HTTP 503'); return NONE }
    const r = await ambiguity({ input, out, callModel: down })
    expect(r.pass).toBe(false)
    expect(r.runs[0].error).toBe('HTTP 503')
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

describe('prompt and answer', () => {
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
    expect(JSON.parse(a.init.body as string)).toEqual({ model: 'claude-x', max_tokens: 4096, temperature: 0, system: 'S', messages: [{ role: 'user', content: 'U' }] })
    const o = modelRequest('openai:gpt-x@v1', call, 'k')
    expect(o.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(o.init.headers).toMatchObject({ authorization: 'Bearer k' })
    expect(JSON.parse(o.init.body as string)).toMatchObject({ model: 'gpt-x', temperature: 0, seed: 0, response_format: { type: 'json_object' } })
    const g = modelRequest('google:gemini-x@v1', call, 'k')
    expect(g.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent')
    expect(JSON.parse(g.init.body as string).generationConfig).toEqual({ temperature: 0, responseMimeType: 'application/json' })
    expect(() => modelRequest('mistral:m@1', call, 'k')).toThrow(/no client/)
  })

  test('response text per provider', () => {
    expect(responseText('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab')
    expect(responseText('openai', { choices: [{ message: { content: 'o' } }] })).toBe('o')
    expect(responseText('google', { candidates: [{ content: { parts: [{ text: 'g' }] } }] })).toBe('g')
    expect(() => responseText('openai', { choices: [] })).toThrow(/empty response/)
  })

  test('retries 429 and 5xx with back-off, then gives up; a missing key is an error', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number) => { sleeps.push(ms) }
    let n = 0
    const flaky = (async () => (n++ < 2 ? new Response('busy', { status: 429 }) : Response.json({ choices: [{ message: { content: NONE } }] }))) as unknown as typeof fetch
    expect(await httpModelClient({ OPENAI_API_KEY: 'k' }, flaky, sleep)('openai:gpt-x@1', call)).toBe(NONE)
    expect(sleeps).toEqual([1000, 2000])
    const down = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    await expect(httpModelClient({ OPENAI_API_KEY: 'k' }, down, sleep)('openai:gpt-x@1', call)).rejects.toThrow(/HTTP 503/)
    const bad = (async () => new Response('no', { status: 400 })) as unknown as typeof fetch
    await expect(httpModelClient({ GEMINI_API_KEY: 'k' }, bad, sleep)('google:g@1', call)).rejects.toThrow(/HTTP 400/)
    await expect(httpModelClient({}, down, sleep)('anthropic:c@1', call)).rejects.toThrow(/set ANTHROPIC_API_KEY/)
  })
})
