// Task O30.3: a byte-for-byte mirror of src/libraries/ClaimRenderer.sol (plan §6.3 rule 6, §6.4, §12.9, ADJ-16):
// the UMA claim a proposal asserts, the template rules, and the registry's worst-case length bound. It works on
// UTF-8 bytes as the library does. Checked against vectors/claim.json, which ClaimVectors.t.sol writes from the
// library itself.
import { type Address, type Hex, concatBytes, getAddress, numberToHex, stringToBytes } from 'viem'

export class InvalidTemplate extends Error {
  constructor() {
    super('InvalidTemplate')
  }
}
export class NoOutcome extends Error {
  constructor() {
    super('NoOutcome')
  }
}

/** In ClaimRenderer's order: the index is the token's `k`. TAU_UNIX (6) is the only optional token. */
export const CLAIM_TOKENS = [
  'MARKET_ID', 'CHAIN_ID', 'ORACLE', 'QUESTION', 'RULES', 'TAU_UTC', 'TAU_UNIX', 'OUTCOME', 'EVIDENCE', 'EVIDENCE_HASH',
] as const
const TAU_UNIX = 6
const TOKEN_BYTES = CLAIM_TOKENS.map((t) => stringToBytes(`{{${t}}}`))

// Fixed output sizes of the worst-case bound (plan §6.3 rule 6), as in the library.
const FIXED_TOKEN_OUTPUT = 66 + 20 + 42 + 20 + 20 + 7 + 66 // MARKET_ID, CHAIN_ID, ORACLE, TAU_UTC, TAU_UNIX, OUTCOME, EVIDENCE_HASH
const MIN_EVIDENCE = 256 // MAX_EVIDENCE_URI_BYTES
const L1_EVIDENCE_FIXED = 26 + 66 + 9 // "Layer 1 CRE report, value " + hash + ", source "

export type ClaimFields = {
  marketId: Hex
  chainId: bigint
  oracle: Address
  question: string
  rules: string
  tau: bigint
  outcome: number // Outcome: 1 YES, 2 NO, 3 INVALID (0 NONE refused)
  evidence: string
  evidenceHash: Hex
}

const OPEN = 0x7b // '{'

/** The next "{{" at or after `from`, or -1. */
function nextOpen(t: Uint8Array, from: number): number {
  for (let i = from; i + 1 < t.length; i++) if (t[i] === OPEN && t[i + 1] === OPEN) return i
  return -1
}

/** The token starting at `i` (braces included), or -1. */
function tokenAt(t: Uint8Array, i: number): number {
  outer: for (let k = 0; k < TOKEN_BYTES.length; k++) {
    const tok = TOKEN_BYTES[k]
    if (i + tok.length > t.length) continue
    for (let j = 0; j < tok.length; j++) if (t[i + j] !== tok[j]) continue outer
    return k
  }
  return -1
}

/** Token positions in template order; null when a "{{" does not start a token. */
function scan(t: Uint8Array): { at: number; k: number }[] | null {
  const found: { at: number; k: number }[] = []
  for (let i = 0; ; ) {
    const at = nextOpen(t, i)
    if (at < 0) return found
    const k = tokenAt(t, at)
    if (k < 0) return null
    found.push({ at, k })
    i = at + TOKEN_BYTES[k].length
  }
}

function countsValid(found: { k: number }[]): boolean {
  const counts = new Array(CLAIM_TOKENS.length).fill(0)
  for (const { k } of found) counts[k]++
  return counts.every((c, k) => (k === TAU_UNIX ? c <= 1 : c === 1))
}

/** True when the template satisfies the token rules (`isValidTemplate`). */
export function isValidTemplate(template: string): boolean {
  const found = scan(stringToBytes(template))
  return found !== null && countsValid(found)
}

/**
 * The registry's upper bound on the rendered length (`worstCaseLength`); `l1UrlLen` is the byte length of the
 * Layer 1 URL (0 without a feed). Like the library it throws only when a "{{" is not a token; token counts are
 * not checked here.
 */
export function worstCaseLength(template: string, questionLen: number, rulesLen: number, l1UrlLen: number): bigint {
  const t = stringToBytes(template)
  const found = scan(t)
  if (found === null) throw new InvalidTemplate()
  const tokenBytes = found.reduce((s, { k }) => s + TOKEN_BYTES[k].length, 0)
  const l1Text = L1_EVIDENCE_FIXED + l1UrlLen
  return BigInt(t.length - tokenBytes + questionLen + rulesLen + FIXED_TOKEN_OUTPUT + Math.max(l1Text, MIN_EVIDENCE))
}

const hex32 = (h: Hex) => numberToHex(BigInt(h), { size: 32 })

/** The `{{EVIDENCE}}` text of a Layer 1 proposal (`l1Evidence`). */
export const l1Evidence = (valueHash: Hex, url: string): string => `Layer 1 CRE report, value ${hex32(valueHash)}, source ${url}`

/** Proleptic Gregorian date of a day count since 1970-01-01 (the algorithm Solady's DateTimeLib uses). */
function civil(days: bigint): [bigint, bigint, bigint] {
  const z = days + 719468n
  const era = z / 146097n
  const doe = z - era * 146097n
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n)
  const mp = (5n * doy + 2n) / 153n
  const d = doy - (153n * mp + 2n) / 5n + 1n
  const m = mp < 10n ? mp + 3n : mp - 9n
  return [yoe + era * 400n + (m <= 2n ? 1n : 0n), m, d]
}

const pad = (v: bigint, w: number) => v.toString().padStart(w, '0')

/** `YYYY-MM-DDTHH:MM:SSZ`, years past 9999 unpadded and unclipped, as the library writes them. */
export function utc(ts: bigint): string {
  const [y, mo, d] = civil(ts / 86400n)
  const s = ts % 86400n
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(s / 3600n, 2)}:${pad((s % 3600n) / 60n, 2)}:${pad(s % 60n, 2)}Z`
}

function value(k: number, f: ClaimFields): string {
  switch (CLAIM_TOKENS[k]) {
    case 'MARKET_ID': return hex32(f.marketId)
    case 'CHAIN_ID': return f.chainId.toString()
    case 'ORACLE': return getAddress(f.oracle)
    case 'QUESTION': return f.question
    case 'RULES': return f.rules
    case 'TAU_UTC': return utc(f.tau)
    case 'TAU_UNIX': return f.tau.toString()
    case 'OUTCOME': return f.outcome === 1 ? 'YES' : f.outcome === 2 ? 'NO' : 'INVALID'
    case 'EVIDENCE': return f.evidence
    default: return hex32(f.evidenceHash)
  }
}

/** One-pass render (`render`): throws InvalidTemplate on a template that breaks the rules, then NoOutcome. */
export function renderClaim(template: string, f: ClaimFields): Uint8Array {
  if (f.tau < 0n || f.tau >= 1n << 64n) throw new RangeError('tau is not a uint64')
  if (f.chainId < 0n || f.chainId >= 1n << 256n) throw new RangeError('chainId is not a uint256')
  if (!Number.isInteger(f.outcome) || f.outcome < 0 || f.outcome > 3) throw new RangeError('outcome is not an Outcome')
  const t = stringToBytes(template)
  const found = scan(t)
  if (found === null || !countsValid(found)) throw new InvalidTemplate()
  if (f.outcome === 0) throw new NoOutcome()
  const parts: Uint8Array[] = []
  let i = 0
  for (const { at, k } of found) {
    parts.push(t.subarray(i, at), stringToBytes(value(k, f)))
    i = at + TOKEN_BYTES[k].length
  }
  parts.push(t.subarray(i))
  return concatBytes(parts)
}
