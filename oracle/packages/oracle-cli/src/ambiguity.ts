// `oracle-cli ambiguity` (plan §12.9 step 5, O22.3): gives the question and rules alone to the three panel
// models (the ones the pack's ai.modelIdHashes name) with "list outcomes these rules do not decide", writes
// listings/<marketId>/ambiguity.log and, when every model lists nothing, sets pack.json's ambiguityLogHash to
// keccak256 of the log. Any listed case, model failure or invalid answer fails the pass and leaves the hash
// zero: fix the rules (and re-run `list`) until none remain.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Hex, keccak256, toBytes } from 'viem'
import { ListError, packDir, readListing, ZERO32 } from './list'
import { type CallModel, httpModelClient, type ModelCall } from './models'

export const PROMPT_PATH = new URL('../prompts/ambiguity.txt', import.meta.url).pathname

export type AmbiguityOptions = {
  input: string
  out?: string
  callModel?: CallModel
  env?: Record<string, string | undefined>
  now?: () => Date
}

export type Undecided = { case: string; why: string }
export type ModelRun = { model: string; modelIdHash: Hex; response?: string; undecided?: Undecided[]; error?: string }
export type AmbiguityResult = { dir: string; pass: boolean; ambiguityLogHash: Hex; runs: ModelRun[] }

/** The pinned prompt split into its SYSTEM and USER parts, with the market text substituted. */
export function ambiguityPrompt(template: string, question: string, rules: string): ModelCall {
  const m = /^SYSTEM\n([\s\S]*?)\n\nUSER\n([\s\S]*)$/.exec(template)
  if (!m) throw new ListError('prompts/ambiguity.txt must be "SYSTEM\\n...\\n\\nUSER\\n..."')
  return { system: m[1].trim(), user: m[2].replace('{{QUESTION}}', () => question).replace('{{RULES}}', () => rules).trim() }
}

/** The model's answer as a list of undecided cases; throws on anything but the requested JSON. */
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

export async function ambiguity(o: AmbiguityOptions): Promise<AmbiguityResult> {
  const input = readListing(o.input)
  if (!input.ambiguity) throw new ListError('the listing input has no ambiguity.models (the three panel models)')
  const models = input.ambiguity.models
  const hashes = input.marketInput.ai.modelIdHashes
  models.forEach((m, i) => {
    if (keccak256(toBytes(m)) !== hashes[i].toLowerCase()) {
      throw new ListError(`ambiguity.models[${i}] "${m}" is not ai.modelIdHashes[${i}] (keccak256 ${keccak256(toBytes(m))})`)
    }
  })
  const dir = packDir(input, o.out)
  const packPath = join(dir, 'pack.json')
  if (!existsSync(packPath)) throw new ListError(`${packPath} is missing: run oracle-cli list first`)
  const packText = readFileSync(packPath, 'utf8')
  const pack = JSON.parse(packText) // only strings are read: no precision concern
  const { question, rules } = input.marketInput
  if (pack.marketInput.question !== question || pack.marketInput.rules !== rules) {
    throw new ListError('pack.json has another question or rules than the input: re-run oracle-cli list')
  }

  const template = readFileSync(PROMPT_PATH, 'utf8')
  const call = ambiguityPrompt(template, question, rules)
  const callModel = o.callModel ?? httpModelClient(o.env)
  // Independent calls; no model sees another's answer.
  const runs: ModelRun[] = await Promise.all(
    models.map(async (model, i): Promise<ModelRun> => {
      const run: ModelRun = { model, modelIdHash: hashes[i] as Hex }
      try {
        run.response = await callModel(model, call)
        run.undecided = parseUndecided(run.response)
      } catch (e) {
        run.error = e instanceof Error ? e.message : String(e)
      }
      return run
    }),
  )
  const pass = runs.every((r) => r.error === undefined && r.undecided?.length === 0)
  const log = JSON.stringify(
    {
      tool: 'oracle-cli ambiguity (O22.3)',
      marketId: pack.marketInput.marketId,
      ranAt: (o.now?.() ?? new Date()).toISOString(),
      promptHash: keccak256(toBytes(template)),
      question,
      rules,
      rulesHash: keccak256(toBytes(rules)),
      runs,
      result: pass ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ) + '\n'
  writeFileSync(join(dir, 'ambiguity.log'), log)
  const ambiguityLogHash = pass ? keccak256(toBytes(log)) : (ZERO32 as Hex)
  const updated = packText.replace(/("ambiguityLogHash": )"0x[0-9a-fA-F]{64}"/, `$1"${ambiguityLogHash}"`)
  if (updated === packText && !packText.includes(`"ambiguityLogHash": "${ambiguityLogHash}"`)) {
    throw new ListError('pack.json has no ambiguityLogHash field')
  }
  writeFileSync(packPath, updated)
  return { dir, pass, ambiguityLogHash, runs }
}
