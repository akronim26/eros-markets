// `oracle-cli ambiguity`: asks each panel model which outcomes the question and rules leave undecided, and writes
// ambiguity.log. ambiguityLogHash is set only when no model lists a case or the team triages every listed case;
// otherwise it stays zero.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Hex, keccak256, toBytes } from 'viem'
import { ListError, packDir, readListing, ZERO32 } from './list'
import type { Listing } from './schema'
import { type CallModel, httpModelClient, type ModelCall, temperatureFor } from './models'

export const PROMPT_PATH = fileURLToPath(new URL('../prompts/ambiguity.txt', import.meta.url))

export type AmbiguityOptions = {
  input: string
  out?: string
  callModel?: CallModel
  env?: Record<string, string | undefined>
  now?: () => Date
}

export type Undecided = { case: string; why: string }
export type ModelRun = {
  model: string
  modelIdHash: Hex
  temperature: number
  response?: string
  undecided?: Undecided[]
  error?: string
  /** Retried attempts: empty, cut off or not the required JSON. */
  failedAttempts?: { error: string; response?: string }[]
}

/** Retries for an empty, cut-off or malformed answer (the panel runner's rule). */
export const ANSWER_RETRIES = 3
export type AmbiguityResult = {
  dir: string
  pass: boolean
  result: 'PASS' | 'NEEDS_TRIAGE' | 'FAIL' | 'PASS_TRIAGED'
  ambiguityLogHash: Hex
  runs: ModelRun[]
}

/** The pinned prompt's SYSTEM and USER parts, with the market text substituted. */
export function ambiguityPrompt(template: string, question: string, rules: string): ModelCall {
  const m = /^SYSTEM\n([\s\S]*?)\n\nUSER\n([\s\S]*)$/.exec(template.replaceAll('\r\n', '\n'))
  if (!m) throw new ListError('prompts/ambiguity.txt must be "SYSTEM\\n...\\n\\nUSER\\n..."')
  return { system: m[1].trim(), user: m[2].replace('{{QUESTION}}', () => question).replace('{{RULES}}', () => rules).trim() }
}

/** Throws on anything but the requested JSON. */
export function parseUndecided(text: string): Undecided[] {
  const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
  let v: any
  try {
    v = JSON.parse(body)
  } catch {
    throw new Error('answer is not JSON')
  }
  const list = v?.undecided
  if (!Array.isArray(list) || Object.keys(v).length !== 1) throw new Error('answer is not {"undecided": [...]}')
  return list.map((x: any, i: number) => {
    if (typeof x?.case !== 'string' || typeof x?.why !== 'string' || x.case.trim() === '') throw new Error(`entry ${i} is not {case, why}`)
    return { case: x.case, why: x.why }
  })
}

type Ctx = { input: Listing; dir: string; packPath: string; packText: string; marketId: Hex }

/** Checks that the models match ai.modelIdHashes and the pack has the input's text. */
function context(inputPath: string, out?: string): Ctx {
  const input = readListing(inputPath)
  if (!input.ambiguity) throw new ListError('the listing input has no ambiguity.models (the three panel models)')
  const hashes = input.marketInput.ai.modelIdHashes
  input.ambiguity.models.forEach((m, i) => {
    if (keccak256(toBytes(m)) !== hashes[i].toLowerCase()) {
      throw new ListError(`ambiguity.models[${i}] "${m}" is not ai.modelIdHashes[${i}] (keccak256 ${keccak256(toBytes(m))})`)
    }
  })
  const dir = packDir(input, out)
  const packPath = join(dir, 'pack.json')
  if (!existsSync(packPath)) throw new ListError(`${packPath} is missing: run oracle-cli list first`)
  const packText = readFileSync(packPath, 'utf8')
  const pack = JSON.parse(packText) // only strings are read, so number precision does not matter
  const { question, rules } = input.marketInput
  if (pack.marketInput.question !== question || pack.marketInput.rules !== rules) {
    throw new ListError('pack.json has another question or rules than the input: re-run oracle-cli list')
  }
  return { input, dir, packPath, packText, marketId: pack.marketInput.marketId }
}

/** Sets ambiguityLogHash to keccak256 of the log on a pass, zero otherwise. */
function writeLog(c: Ctx, log: object, pass: boolean): Hex {
  const text = JSON.stringify(log, null, 2) + '\n'
  writeFileSync(join(c.dir, 'ambiguity.log'), text)
  const hash = pass ? keccak256(toBytes(text)) : (ZERO32 as Hex)
  const updated = c.packText.replace(/("ambiguityLogHash": )"0x[0-9a-fA-F]{64}"/, `$1"${hash}"`)
  if (updated === c.packText && !c.packText.includes(`"ambiguityLogHash": "${hash}"`)) {
    throw new ListError('pack.json has no ambiguityLogHash field')
  }
  writeFileSync(c.packPath, updated)
  return hash
}

export const TRIAGE_FILE = 'ambiguity-triage.json'

export async function ambiguity(o: AmbiguityOptions): Promise<AmbiguityResult> {
  const c = context(o.input, o.out)
  const models = c.input.ambiguity!.models
  const hashes = c.input.marketInput.ai.modelIdHashes
  const { question, rules } = c.input.marketInput
  const template = readFileSync(PROMPT_PATH, 'utf8')
  const call = ambiguityPrompt(template, question, rules)
  const callModel = o.callModel ?? httpModelClient(o.env)
  // Independent calls; no model sees another's answer.
  const runs: ModelRun[] = await Promise.all(
    models.map(async (model, i): Promise<ModelRun> => {
      const run: ModelRun = { model, modelIdHash: hashes[i] as Hex, temperature: temperatureFor(model) }
      for (let attempt = 0; attempt <= ANSWER_RETRIES; attempt++) {
        let response: string | undefined
        try {
          response = await callModel(model, call)
          run.undecided = parseUndecided(response)
          run.response = response
          delete run.error
          break
        } catch (e) {
          run.error = e instanceof Error ? e.message : String(e)
          if (attempt < ANSWER_RETRIES) (run.failedAttempts ??= []).push({ error: run.error, ...(response !== undefined ? { response } : {}) })
          else if (response !== undefined) run.response = response
        }
      }
      return run
    }),
  )
  const answered = runs.every((r) => r.error === undefined)
  const pass = answered && runs.every((r) => r.undecided!.length === 0)
  const result: AmbiguityResult['result'] = pass ? 'PASS' : answered ? 'NEEDS_TRIAGE' : 'FAIL'
  const log = {
    tool: 'oracle-cli ambiguity (O22.3)',
    marketId: c.marketId,
    ranAt: (o.now?.() ?? new Date()).toISOString(),
    promptHash: keccak256(toBytes(template)),
    question,
    rules,
    rulesHash: keccak256(toBytes(rules)),
    runs,
    result,
  }
  const ambiguityLogHash = writeLog(c, log, pass)
  if (result === 'NEEDS_TRIAGE') {
    // One entry per listed case for the team to fill in.
    const items = runs.flatMap((r) => r.undecided!.map((u, index) => ({
      model: r.model, index, case: u.case, disposition: '', clause: '', reason: '',
    })))
    writeFileSync(join(c.dir, TRIAGE_FILE), JSON.stringify({ triagedBy: '', ranAt: log.ranAt, items }, null, 2) + '\n')
  }
  return { dir: c.dir, pass, result, ambiguityLogHash, runs }
}

export type TriageItem = { model: string; index: number; case: string; disposition: 'decided' | 'immaterial'; clause?: string; reason: string }
export type Triage = { triagedBy: string; ranAt: string; items: TriageItem[] }

/**
 * Applies the team's triage (ADJ-37): every listed case is "decided" with an exact quote from the rules, or
 * "immaterial" with a reason. A case that needs a rules fix is not triaged; fix the rules and re-run instead.
 */
export function applyTriage(o: { input: string; out?: string; triage?: string; now?: () => Date }): AmbiguityResult {
  const c = context(o.input, o.out)
  const logPath = join(c.dir, 'ambiguity.log')
  if (!existsSync(logPath)) throw new ListError(`${logPath} is missing: run oracle-cli ambiguity first`)
  const log = JSON.parse(readFileSync(logPath, 'utf8'))
  const { question, rules } = c.input.marketInput
  if (log.question !== question || log.rules !== rules) throw new ListError('ambiguity.log is for other rules: run the pass again')
  if (log.result !== 'NEEDS_TRIAGE') throw new ListError(`ambiguity.log is ${log.result}; only a NEEDS_TRIAGE pass (every model answered) is triaged`)
  const t = JSON.parse(readFileSync(o.triage ?? join(c.dir, TRIAGE_FILE), 'utf8')) as Triage
  const problems: string[] = []
  if (typeof t.triagedBy !== 'string' || t.triagedBy.trim() === '') problems.push('triagedBy is empty')
  if (t.ranAt !== log.ranAt) problems.push(`the triage is for the pass of ${t.ranAt}, the log is from ${log.ranAt}`)
  const listed = (log.runs as ModelRun[]).flatMap((r) => r.undecided!.map((u, index) => ({ model: r.model, index, case: u.case })))
  const key = (x: { model: string; index: number }) => `${x.model}#${x.index}`
  const byKey = new Map<string, TriageItem>()
  for (const item of t.items ?? []) {
    if (byKey.has(key(item))) problems.push(`${key(item)} is triaged twice`)
    byKey.set(key(item), item)
  }
  for (const l of listed) {
    const item = byKey.get(key(l))
    byKey.delete(key(l))
    if (!item) { problems.push(`${key(l)} has no disposition`); continue }
    if (item.case !== l.case) { problems.push(`${key(l)}: the case text differs from the log`); continue }
    if (typeof item.reason !== 'string' || item.reason.trim() === '') problems.push(`${key(l)}: no reason`)
    if (item.disposition === 'decided') {
      if (!item.clause || !rules.includes(item.clause)) problems.push(`${key(l)}: "decided" needs a clause quoted exactly from the rules`)
    } else if (item.disposition !== 'immaterial') {
      problems.push(`${key(l)}: disposition must be "decided" or "immaterial" (a case that needs a fix: change the rules and re-run)`)
    }
  }
  for (const k of byKey.keys()) problems.push(`${k} is not a case in the log`)
  if (problems.length > 0) throw new ListError(`triage rejected:\n  ${problems.join('\n  ')}`)

  const items = (t.items as TriageItem[]).map(({ model, index, case: text, disposition, clause, reason }) =>
    disposition === 'decided' ? { model, index, case: text, disposition, clause, reason } : { model, index, case: text, disposition, reason })
  const triaged = { ...log, triage: { triagedBy: t.triagedBy, triagedAt: (o.now?.() ?? new Date()).toISOString(), items }, result: 'PASS_TRIAGED' }
  const ambiguityLogHash = writeLog(c, triaged, true)
  return { dir: c.dir, pass: true, result: 'PASS_TRIAGED', ambiguityLogHash, runs: log.runs }
}
