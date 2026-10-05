// Prompt-attack classifier: Llama Prompt Guard 2 on Groq, which returns an attack probability. Its window is 512
// tokens, so text is scanned in overlapping chunks and an item scores its highest chunk. A classifier that cannot
// answer after retries is reported, and the caller treats the item as suspect.
import { retryDelayMs } from '@eros-oracle/oracle-sdk'

export const CLASSIFIER_MODEL = 'groq:meta-llama/llama-prompt-guard-2-86m@2026-10-03'
export const CLASSIFIER_THRESHOLD = 0.5
export const CHUNK_CHARS = 800 // well inside 512 tokens for any script
export const CHUNK_OVERLAP = 100 // a phrase split at a boundary is still whole in one chunk

const URL_ = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL_ID = 'meta-llama/llama-prompt-guard-2-86m'

export class ClassifierUnavailable extends Error {}

export type ClassifierDeps = { env?: Record<string, string | undefined>; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> }

/** Overlapping windows of `text` (code points), each at most CHUNK_CHARS. */
export function chunks(text: string): string[] {
  const cps = [...text]
  if (cps.length <= CHUNK_CHARS) return cps.length ? [text] : []
  const out: string[] = []
  for (let at = 0; at < cps.length; at += CHUNK_CHARS - CHUNK_OVERLAP) {
    out.push(cps.slice(at, at + CHUNK_CHARS).join(''))
    if (at + CHUNK_CHARS >= cps.length) break
  }
  return out
}

async function scoreChunk(chunk: string, deps: Required<ClassifierDeps>): Promise<number> {
  const key = deps.env.GROQ_API_KEY
  if (!key) throw new ClassifierUnavailable('set GROQ_API_KEY')
  let last = ''
  for (let attempt = 0; attempt <= 3; attempt++) {
    let retryAfter: string | null = null
    try {
      const res = await deps.fetchFn(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: chunk }] }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
        const raw = body.choices?.[0]?.message?.content
        const score = typeof raw === 'string' && /^\s*[0-9.eE+-]+\s*$/.test(raw) ? Number(raw) : Number.NaN
        if (!(score >= 0 && score <= 1)) throw new ClassifierUnavailable(`unexpected classifier answer ${JSON.stringify(raw)}`)
        return score
      }
      last = `HTTP ${res.status}`
      if (res.status !== 429 && res.status < 500) throw new ClassifierUnavailable(`${last} ${(await res.text()).slice(0, 200)}`)
      retryAfter = res.headers.get('retry-after')
      await res.arrayBuffer()
    } catch (e) {
      if (e instanceof ClassifierUnavailable) throw e
      last = e instanceof Error ? e.message : String(e)
    }
    if (attempt < 3) await deps.sleep(retryDelayMs(attempt, retryAfter))
  }
  throw new ClassifierUnavailable(`classifier failed 4 times (last: ${last})`)
}

/** The highest chunk probability; 0 for empty text. */
export async function classify(text: string, deps: ClassifierDeps = {}): Promise<number> {
  const d: Required<ClassifierDeps> = { env: deps.env ?? process.env, fetchFn: deps.fetchFn ?? fetch, sleep: deps.sleep ?? Bun.sleep }
  let max = 0
  for (const c of chunks(text)) {
    const s = await scoreChunk(c, d)
    if (s > max) max = s
    if (max >= CLASSIFIER_THRESHOLD) break // one attacking chunk is enough
  }
  return max
}
