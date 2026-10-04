// RFC 8785 canonical JSON and `evidenceHash = keccak256(canonicalBytes)`, which proposals commit to onchain. Anything
// JSON cannot carry (undefined, NaN, bigint, a lone surrogate, a cycle, ...) throws rather than being dropped.
import { type Hex, keccak256 } from 'viem'

export class JcsError extends Error {}

export function canonicalize(value: unknown): string {
  return serialize(value, new Set())
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value))
}

export function evidenceHash(snapshot: unknown): Hex {
  return keccak256(canonicalBytes(snapshot))
}

function serialize(v: unknown, path: Set<object>): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(v)) throw new JcsError(`${v} is not a JSON number`)
      return String(v) // ECMA-262 Number::toString, as RFC 8785 requires; -0 gives "0"
    case 'string':
      return quote(v)
    case 'object':
      break
    default:
      throw new JcsError(`a ${typeof v} is not a JSON value`)
  }
  const o = v as object
  if (path.has(o)) throw new JcsError('cyclic structure')
  path.add(o)
  try {
    if (Array.isArray(o)) return `[${o.map((x) => serialize(x, path)).join(',')}]`
    const proto = Object.getPrototypeOf(o)
    if (proto !== Object.prototype && proto !== null) throw new JcsError(`a ${proto?.constructor?.name ?? 'non-plain'} object is not a JSON value`)
    const keys = Object.keys(o).sort(byCodeUnits)
    return `{${keys.map((k) => `${quote(k)}:${serialize((o as Record<string, unknown>)[k], path)}`).join(',')}}`
  } finally {
    path.delete(o)
  }
}

/** UTF-16 code unit order, locale-independent. */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const SHORT: Record<number, string> = { 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r', 0x22: '\\"', 0x5c: '\\\\' }

/** The five short escapes, other controls as lowercase \u00hh, everything else as is. */
function quote(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d < 0xdc00 || d > 0xdfff) throw new JcsError(`lone surrogate U+${c.toString(16).toUpperCase()} at ${i}`)
      out += s[i] + s[i + 1]
      i++
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new JcsError(`lone surrogate U+${c.toString(16).toUpperCase()} at ${i}`)
    const short = SHORT[c]
    if (short) out += short
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += s[i]
  }
  return `${out}"`
}
