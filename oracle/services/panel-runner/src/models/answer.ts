// Task O33.1: a panel model's answer (plan §8.3). Structured output `{label, confidence, cited, rationale}`, the JSON
// schema enforced here whatever the provider did: anything else is invalid output, which counts as an API failure
// (retried, then ABSTAIN). Citations are checked against the snapshot afterwards: a label with no valid citation,
// or citing only context (non-allow-listed) items, is ABSTAIN.
import type { Item } from '@eros-oracle/snapshotter'

export const LABELS = ['YES', 'NO', 'INVALID', 'NOT_YET'] as const
export type Label = (typeof LABELS)[number]

/** The contract's PanelLabel codes (OracleTypes.sol): ABSTAIN 0, YES 1, NO 2, INVALID 3, NOT_YET 4. */
export const PANEL_LABEL = { ABSTAIN: 0, YES: 1, NO: 2, INVALID: 3, NOT_YET: 4 } as const

export const RATIONALE_MAX_CHARS = 1000

export type Answer = { label: Label; confidence: number; cited: number[]; rationale: string }

/**
 * The schema sent to providers that enforce one (OpenAI strict mode: no numeric or length bounds, so those are
 * checked here). The same shape is stated in the prompt for the others.
 */
export const ANSWER_SCHEMA = {
  name: 'panel_answer',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'confidence', 'cited', 'rationale'],
    properties: {
      label: { type: 'string', enum: [...LABELS] },
      confidence: { type: 'number' },
      cited: { type: 'array', items: { type: 'integer' } },
      rationale: { type: 'string' },
    },
  },
} as const

export class InvalidAnswer extends Error {}

/** The answer in `text`, or InvalidAnswer. A single ```json fenced block is accepted; nothing else around it. */
export function parseAnswer(text: string): Answer {
  const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch {
    throw new InvalidAnswer('answer is not JSON')
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new InvalidAnswer('answer is not a JSON object')
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  if (keys.join(',') !== 'cited,confidence,label,rationale') throw new InvalidAnswer(`answer has keys [${keys.join(', ')}], expected label, confidence, cited, rationale`)
  if (typeof o.label !== 'string' || !(LABELS as readonly string[]).includes(o.label)) throw new InvalidAnswer(`label ${JSON.stringify(o.label)} is not one of ${LABELS.join(', ')}`)
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    throw new InvalidAnswer(`confidence ${JSON.stringify(o.confidence)} is not a number in [0, 1]`)
  }
  if (!Array.isArray(o.cited) || !o.cited.every((i) => Number.isInteger(i) && i >= 0)) throw new InvalidAnswer('cited is not a list of item indexes')
  if (typeof o.rationale !== 'string') throw new InvalidAnswer('rationale is not a string')
  const chars = [...o.rationale].length
  if (chars > RATIONALE_MAX_CHARS) throw new InvalidAnswer(`rationale has ${chars} characters (at most ${RATIONALE_MAX_CHARS})`)
  return { label: o.label as Label, confidence: o.confidence, cited: [...new Set(o.cited as number[])], rationale: o.rationale }
}

export type CitationCheck = { valid: number[]; reason?: 'NO_VALID_CITATION' | 'ONLY_CONTEXT_CITED' }

/**
 * The cited items that exist in the snapshot and hold a response (a fetch that got none has nothing to cite). No
 * valid citation → NO_VALID_CITATION; valid citations all of context items → ONLY_CONTEXT_CITED (plan §8.2).
 */
export function checkCitations(cited: number[], items: readonly Item[]): CitationCheck {
  const valid = cited.filter((i) => i < items.length && items[i].httpStatus !== 0)
  if (valid.length === 0) return { valid, reason: 'NO_VALID_CITATION' }
  if (!valid.some((i) => items[i].allowListed)) return { valid, reason: 'ONLY_CONTEXT_CITED' }
  return { valid }
}
