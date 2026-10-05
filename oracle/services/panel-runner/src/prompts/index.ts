// Task O33.2: the pinned panel prompts (plan §8.3). One template per category in templates/<category>.txt;
// `promptHash = keccak256(template bytes)` and `categoryId = keccak256(category name)`. A template's first line pins
// how evidence is put into it (`item_chars`, `evidence_chars`), so the hash commits to that too. The rest is
// "SYSTEM\n...\n\nUSER\n..." with {{QUESTION}}, {{RULES}}, {{TAU_UTC}}, {{TAKEN_AT_UTC}} and {{EVIDENCE}}.
//
// Evidence (EM-15 defence 1): each snapshot item becomes an <evidence ... trust="untrusted"> element holding one JSON
// string of the item's prompt text, with every <, >, & and line separator escaped, so nothing inside can close the
// element, open another or start a new line. Attribute values are built from checked fields only. Items without text
// (binary, no response) appear with `null`. Text beyond the pinned budgets is cut and marked `shortened="true"`.
import type { ModelCall } from '@eros-oracle/oracle-sdk'
import { promptText, type Snapshot } from '@eros-oracle/snapshotter'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Hex, keccak256, stringToBytes } from 'viem'

export const CATEGORIES = ['sports', 'macro', 'elections', 'politics', 'crypto', 'companies', 'other', 'crypto-price'] as const
export type Category = (typeof CATEGORIES)[number]

export class PromptError extends Error {}

export type PinnedPrompt = { category: Category; categoryId: Hex; promptHash: Hex; template: string; itemChars: number; evidenceChars: number }

const HEADER = /^# eros-panel-prompt v1 item_chars=(\d+) evidence_chars=(\d+)\n/

/** A template's pinned parts; throws on anything but the v1 layout. */
export function parseTemplate(category: Category, template: string): PinnedPrompt {
  const h = HEADER.exec(template)
  if (!h) throw new PromptError(`${category}: the first line must be "# eros-panel-prompt v1 item_chars=<n> evidence_chars=<n>"`)
  const body = template.slice(h[0].length)
  if (!/^SYSTEM\n[\s\S]+?\n\nUSER\n[\s\S]+$/.test(body)) throw new PromptError(`${category}: expected "SYSTEM\\n...\\n\\nUSER\\n..." after the header`)
  for (const k of ['QUESTION', 'RULES', 'TAU_UTC', 'TAKEN_AT_UTC', 'EVIDENCE']) {
    if (!body.includes(`{{${k}}}`)) throw new PromptError(`${category}: no {{${k}}}`)
  }
  return {
    category,
    categoryId: keccak256(stringToBytes(category)),
    promptHash: keccak256(stringToBytes(template)),
    template,
    itemChars: Number(h[1]),
    evidenceChars: Number(h[2]),
  }
}

const TEMPLATES = fileURLToPath(new URL('./templates/', import.meta.url))

/** Every category's pinned prompt, read from templates/. */
export function loadPrompts(dir = TEMPLATES): PinnedPrompt[] {
  return CATEGORIES.map((c) => parseTemplate(c, readFileSync(join(dir, `${c}.txt`), 'utf8')))
}

/** The prompt a market's AIConfig pins: its categoryId and promptHash must both match a template. */
export function promptFor(prompts: readonly PinnedPrompt[], categoryId: string, promptHash: string): PinnedPrompt {
  const p = prompts.find((x) => x.categoryId === categoryId.toLowerCase())
  if (!p) throw new PromptError(`no prompt for categoryId ${categoryId}`)
  if (p.promptHash !== promptHash.toLowerCase()) throw new PromptError(`${p.category}: the market pins promptHash ${promptHash}, the template is ${p.promptHash}`)
  return p
}

/** A backslash-u escape for one UTF-16 code unit (built from the code, never written as an escape in source). */
const esc = (ch: string) => `${String.fromCharCode(92)}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
const UNSAFE_IN_STRING = new Set([0x3c, 0x3e, 0x26, 0x2028, 0x2029]) // < > & and the two JS line separators

/** A JSON string literal of `text` with no <, >, & or line separator left raw. */
export function escapeEvidence(text: string): string {
  let out = ''
  for (const ch of JSON.stringify(text)) out += UNSAFE_IN_STRING.has(ch.charCodeAt(0)) ? esc(ch) : ch
  return out
}

const iso = (unix: number | bigint) => new Date(Number(unix) * 1000).toISOString().replace('.000Z', 'Z')
/** A Content-Type as an attribute value: only token characters, at most 100. */
const safeType = (t: string) => t.replace(/[^A-Za-z0-9/.+;= -]/g, '').slice(0, 100)

/** The text each item contributes to the prompt (also what the classifier scans), within the pinned budgets. */
export function evidenceTexts(snapshot: Snapshot, p: Pick<PinnedPrompt, 'itemChars' | 'evidenceChars'>): { text: string | null; shortened: boolean }[] {
  let left = p.evidenceChars
  return snapshot.items.map((item) => {
    const full = promptText(item)
    if (full === null) return { text: null, shortened: false }
    const take = Math.max(0, Math.min(p.itemChars, left))
    const cps = [...full]
    const text = cps.slice(0, take).join('')
    left -= [...text].length
    return { text, shortened: cps.length > take }
  })
}

export function evidenceBlocks(snapshot: Snapshot, p: Pick<PinnedPrompt, 'itemChars' | 'evidenceChars'>): string {
  const texts = evidenceTexts(snapshot, p)
  return snapshot.items
    .map((item, i) => {
      const { text, shortened } = texts[i]
      const attrs = [
        `index="${i}"`,
        `host="${item.host}"`, // hostOf-checked in the snapshot: [a-z0-9.-] only
        `allow_listed="${item.allowListed}"`,
        `http_status="${item.httpStatus}"`,
        `content_type="${safeType(item.contentType)}"`,
        `fetched_at="${iso(item.fetchedAt)}"`,
        `truncated="${item.truncated}"`,
        `shortened="${shortened}"`,
        'trust="untrusted"',
      ]
      return `<evidence ${attrs.join(' ')}>\n${text === null ? 'null' : escapeEvidence(text)}\n</evidence>`
    })
    .join('\n')
}

export type MarketText = { question: string; rules: string; tau: number | bigint }

/** The two messages for one panel call: the template with the market and the snapshot's evidence substituted. */
export function buildCall(p: PinnedPrompt, market: MarketText, snapshot: Snapshot): ModelCall {
  const values: Record<string, string> = {
    QUESTION: market.question,
    RULES: market.rules,
    TAU_UTC: iso(market.tau),
    TAU_MS: String(BigInt(market.tau) * 1000n), // T as epoch milliseconds, for evidence timestamped that way (crypto-price)
    TAKEN_AT_UTC: iso(snapshot.takenAt),
    EVIDENCE: evidenceBlocks(snapshot, p),
  }
  const body = p.template.replace(HEADER, '')
  // One pass over the template: substituted values are never scanned again, so evidence cannot inject a placeholder.
  const filled = body.replace(/\{\{([A-Z_]+)\}\}/g, (whole, k: string) => values[k] ?? whole)
  const m = /^SYSTEM\n([\s\S]*?)\n\nUSER\n([\s\S]*)$/.exec(filled)!
  return { system: m[1].trim(), user: m[2].trim() }
}
