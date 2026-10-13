// FeedSpec evaluator shared by the CRE workflow, the watchdog and the listing CLI. No runtime dependencies, no
// Node or browser APIs, and no floats: numbers stay exact lexemes. URL checks match the registry's, in its order.
import { evaluateFootball } from './football'
import { evaluateSports } from './sports'

export enum ValueType { STRING = 0, INT = 1, DECIMAL = 2 }
export enum Op { EQ = 0, NEQ = 1, GT = 2, GTE = 3, LT = 4, LTE = 5 }

export type FeedSpec = {
  urlTemplate: string
  urlParam: string
  authRef: string // bytes32 hex; 0x00..00 = no auth
  finalPath: string
  finalValue: string
  valuePath: string
  valueType: ValueType
  decimals: number
  op: Op
  target: string
  bufferSecs: number
  l1TimeoutSecs: number
}

export type Status = 'YES' | 'NO' | 'NOT_READY' | 'ERROR'
export type Evaluation = { status: Status; code: string; valueLexeme: string }

export const MAX_BODY_BYTES = 250 * 1024
const SCHEME = 'https://'
const ID = '{id}'
const URL_PARAM_RE = /^[A-Za-z0-9._~-]{1,128}$/
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const SEGMENT_RE = /^[A-Za-z0-9_$-]+(\[(0|[1-9][0-9]{0,5})\])*$/
const INT_RE = /^-?(0|[1-9][0-9]*)$/
const DEC_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/

export class EvalError extends Error {
  constructor(public code: string) { super(code) }
}

// ---------------------------------------------------------------- URL and host

/** Checks the template as the registry does, then substitutes urlParam for `{id}`. */
export function buildUrl(spec: FeedSpec): string {
  checkTemplate(spec.urlTemplate)
  if (!URL_PARAM_RE.test(spec.urlParam)) throw new EvalError('BAD_URL_PARAM')
  const url = spec.urlTemplate.replace(ID, () => spec.urlParam) // a function: no '$' patterns
  hostOf(url)
  return url
}

/** `HostLib.checkTemplate`, in order: https, host, then `{id}` at most once and only after the host's first '/'. */
export function checkTemplate(template: string): void {
  hostOf(template)
  const id = template.indexOf(ID)
  if (id < 0) return
  if (template.indexOf(ID, id + 1) >= 0) throw new EvalError('MULTIPLE_ID_PLACEHOLDERS')
  const slash = template.indexOf('/', hostEnd(template))
  if (slash < 0 || id < slash) throw new EvalError('ID_NOT_IN_PATH')
}

export function hostOf(url: string): string {
  if (!url.startsWith(SCHEME)) throw new EvalError('NOT_HTTPS')
  const host = url.slice(SCHEME.length, hostEnd(url))
  if (!HOST_RE.test(host)) throw new EvalError('BAD_HOST') // rejects userinfo '@', ports, uppercase
  return host
}

/** End of the host: the first '/', '?' or '#' after the scheme, else the length. */
function hostEnd(url: string): number {
  for (let i = SCHEME.length; i < url.length; i++) {
    const c = url[i]
    if (c === '/' || c === '?' || c === '#') return i
  }
  return url.length
}

// ---------------------------------------------------------------- JSON with raw number lexemes

export type JNode =
  | { k: 'obj'; v: Map<string, JNode> }
  | { k: 'arr'; v: JNode[] }
  | { k: 'str'; v: string }
  | { k: 'num'; v: string } // exact lexeme, never parsed to a float
  | { k: 'bool'; v: boolean }
  | { k: 'null' }

export function parseJson(text: string): JNode {
  let i = 0
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++ }
  const fail = (): never => { throw new EvalError('INVALID_JSON') }
  const value = (depth: number): JNode => {
    if (depth > 64) fail()
    ws()
    const c = text[i]
    if (c === '{') {
      i++; const m = new Map<string, JNode>(); ws()
      if (text[i] === '}') { i++; return { k: 'obj', v: m } }
      for (;;) {
        ws(); if (text[i] !== '"') fail()
        const key = str(); ws(); if (text[i] !== ':') fail(); i++
        if (m.has(key)) throw new EvalError('DUPLICATE_KEY') // ambiguous; refuse
        m.set(key, value(depth + 1)); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === '}') { i++; return { k: 'obj', v: m } }
        fail()
      }
    }
    if (c === '[') {
      i++; const a: JNode[] = []; ws()
      if (text[i] === ']') { i++; return { k: 'arr', v: a } }
      for (;;) {
        a.push(value(depth + 1)); ws()
        if (text[i] === ',') { i++; continue }
        if (text[i] === ']') { i++; return { k: 'arr', v: a } }
        fail()
      }
    }
    if (c === '"') return { k: 'str', v: str() }
    if (text.startsWith('true', i)) { i += 4; return { k: 'bool', v: true } }
    if (text.startsWith('false', i)) { i += 5; return { k: 'bool', v: false } }
    if (text.startsWith('null', i)) { i += 4; return { k: 'null' } }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400))
    if (!m || m[0].length === 0) fail()
    i += m![0].length
    return { k: 'num', v: m![0] }
  }
  const str = (): string => {
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail()
      const c = text[i++]
      if (c === '"') return out
      if (c === '\\') {
        const e = text[i++]
        if (e === 'u') {
          const h = text.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail()
          out += String.fromCharCode(parseInt(h, 16)); i += 4
        } else {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
          if (!(e in map)) fail()
          out += map[e]
        }
      } else {
        if (c.charCodeAt(0) < 0x20) fail()
        out += c
      }
    }
  }
  const root = value(0)
  ws()
  if (i !== text.length) fail()
  return root
}

// ---------------------------------------------------------------- paths  a.b[0].c

export function validatePath(path: string): boolean {
  if (path.length === 0 || path.length > 256) return false
  return path.split('.').every((s) => SEGMENT_RE.test(s))
}

export function resolvePath(root: JNode, path: string): JNode | undefined {
  if (!validatePath(path)) throw new EvalError('BAD_PATH')
  let cur: JNode | undefined = root
  for (const seg of path.split('.')) {
    const b = seg.indexOf('[')
    const key = b < 0 ? seg : seg.slice(0, b)
    if (!cur || cur.k !== 'obj') return undefined
    cur = cur.v.get(key)
    if (b >= 0) {
      for (const m of seg.slice(b).matchAll(/\[([0-9]+)\]/g)) {
        // Some APIs (including Gamma's outcomePrices) return a JSON array inside
        // a string. An explicit [index] may traverse that array; scalar strings
        // retain their existing meaning. Reuse the bounded, exact-lexeme parser.
        if (cur?.k === 'str' && cur.v.trimStart().startsWith('[')) cur = parseJson(cur.v)
        if (!cur || cur.k !== 'arr') return undefined
        cur = cur.v[Number(m[1])] // an index (<= 999,999), not a value
      }
    }
  }
  return cur
}

// Canonical text of a scalar, used only for the finality comparison.
function scalarText(n: JNode): string | undefined {
  switch (n.k) {
    case 'str': return n.v
    case 'num': return n.v
    case 'bool': return n.v ? 'true' : 'false'
    case 'null': return 'null'
    default: return undefined
  }
}

// ---------------------------------------------------------------- typed parse

export function parseTyped(raw: string, t: ValueType, decimals: number): bigint | string {
  if (t === ValueType.STRING) return raw
  if (t === ValueType.INT) {
    if (!INT_RE.test(raw)) throw new EvalError('BAD_INT')
    return BigInt(raw)
  }
  if (!DEC_RE.test(raw)) throw new EvalError('BAD_DECIMAL') // rejects exponent, '+', leading zeros
  const neg = raw.startsWith('-')
  const body = neg ? raw.slice(1) : raw
  const [ip, fp = ''] = body.split('.')
  if (fp.length > decimals) throw new EvalError('TOO_MANY_DECIMALS') // never round
  const scaled = BigInt(ip + fp.padEnd(decimals, '0'))
  return neg ? -scaled : scaled
}

function lexemeOf(n: JNode, t: ValueType): string {
  if (t === ValueType.STRING) {
    if (n.k !== 'str') throw new EvalError('VALUE_NOT_STRING')
    return n.v
  }
  if (n.k === 'num' || n.k === 'str') return n.v
  throw new EvalError('VALUE_NOT_NUMERIC')
}

export function compare(a: bigint | string, op: Op, b: bigint | string): boolean {
  if (typeof a === 'string' || typeof b === 'string') {
    if (op === Op.EQ) return a === b
    if (op === Op.NEQ) return a !== b
    throw new EvalError('BAD_OP_FOR_STRING')
  }
  switch (op) {
    case Op.EQ: return a === b
    case Op.NEQ: return a !== b
    case Op.GT: return a > b
    case Op.GTE: return a >= b
    case Op.LT: return a < b
    case Op.LTE: return a <= b
  }
}

// ---------------------------------------------------------------- evaluation

export function evaluateResponse(spec: FeedSpec, statusCode: number, body: string, bodyBytes: number, companion?: { statusCode: number; body: string; bodyBytes: number }): Evaluation {
  try {
    if (statusCode < 200 || statusCode > 299) return { status: 'ERROR', code: `HTTP_${statusCode}`, valueLexeme: '' }
    if (bodyBytes > MAX_BODY_BYTES) return { status: 'ERROR', code: 'BODY_TOO_LARGE', valueLexeme: '' }
    const root = parseJson(body)
    if (spec.finalPath.startsWith('erosSports.')) {
      if (companion && (companion.statusCode !== 200 || companion.bodyBytes > MAX_BODY_BYTES)) return { status: 'ERROR', code: 'SPORTS_COMPANION_UNAVAILABLE', valueLexeme: '' }
      return evaluateSports(spec, root, companion ? parseJson(companion.body) : undefined)
    }
    // This explicit, versioned provider adapter is shared by CRE, listing checks
    // and watchdogs. Its virtual paths are derived only after identity validation.
    if (spec.finalPath.startsWith('erosFootball.') || spec.urlTemplate.startsWith('https://v3.football.api-sports.io/'))
      return evaluateFootball(spec, root)
    const fin = resolvePath(root, spec.finalPath)
    const finText = fin ? scalarText(fin) : undefined
    if (finText === undefined || finText !== spec.finalValue) return { status: 'NOT_READY', code: 'NOT_FINAL', valueLexeme: '' }
    const v = resolvePath(root, spec.valuePath)
    if (!v) return { status: 'ERROR', code: 'VALUE_MISSING', valueLexeme: '' }
    const lex = lexemeOf(v, spec.valueType)
    const value = parseTyped(lex, spec.valueType, spec.decimals)
    const target = parseTyped(spec.target, spec.valueType, spec.decimals)
    return { status: compare(value, spec.op, target) ? 'YES' : 'NO', code: 'OK', valueLexeme: lex }
  } catch (e) {
    return { status: 'ERROR', code: e instanceof EvalError ? e.code : 'INTERNAL', valueLexeme: '' }
  }
}

// ---------------------------------------------------------------- listing validation (registry parity)

/** The registry's bounds for `bufferSecs` and `l1TimeoutSecs`. */
export type TimingBounds = { bufferMinSecs: number; bufferMaxSecs: number; l1TimeoutMinSecs: number; l1TimeoutMaxSecs: number }

/** `IMarketRegistry.BadFeed` codes, as `FeedSpecLib.validate` returns them. */
export const BadFeed = {
  OK: 0, HTTPS: 1, HOST: 2, ID: 3, URL_PARAM: 4, L1_HOST: 5, PATH: 6, FINAL_VALUE: 7,
  OP_TYPE: 8, DECIMALS: 9, TARGET: 10, TIMING: 11, AUTH_REF: 12,
} as const

const MAX_DECIMALS = 18

/**
 * `FeedSpecLib.validate`: the first failing BadFeed code (1..12), or 0. `authRefKnown` is
 * `spec.authRef == 0 || registry.authRefKnown(spec.authRef)`.
 */
export function validateSpec(spec: FeedSpec, l1Host: string, authRefKnown: boolean, b: TimingBounds): number {
  const url = codeOfThrow(() => checkTemplate(spec.urlTemplate))
  if (url === 'NOT_HTTPS') return BadFeed.HTTPS
  if (url === 'BAD_HOST') return BadFeed.HOST
  if (url !== undefined) return BadFeed.ID // MULTIPLE_ID_PLACEHOLDERS, ID_NOT_IN_PATH
  if (!URL_PARAM_RE.test(spec.urlParam)) return BadFeed.URL_PARAM
  if (hostOf(spec.urlTemplate.replace(ID, () => spec.urlParam)) !== l1Host) return BadFeed.L1_HOST
  if (!validatePath(spec.finalPath) || !validatePath(spec.valuePath)) return BadFeed.PATH
  if (spec.finalValue.length === 0) return BadFeed.FINAL_VALUE
  if (!isValidOpForType(spec.valueType, spec.op)) return BadFeed.OP_TYPE
  if (spec.valueType === ValueType.DECIMAL ? spec.decimals > MAX_DECIMALS : spec.decimals !== 0) return BadFeed.DECIMALS
  if (!isValidTarget(spec.target, spec.valueType, spec.decimals)) return BadFeed.TARGET
  const timing =
    spec.bufferSecs < spec.l1TimeoutSecs &&
    spec.bufferSecs >= b.bufferMinSecs && spec.bufferSecs <= b.bufferMaxSecs &&
    spec.l1TimeoutSecs >= b.l1TimeoutMinSecs && spec.l1TimeoutSecs <= b.l1TimeoutMaxSecs
  if (!timing) return BadFeed.TIMING
  if (!authRefKnown) return BadFeed.AUTH_REF
  return BadFeed.OK
}

function isValidOpForType(t: number, op: number): boolean {
  if (t !== ValueType.STRING && t !== ValueType.INT && t !== ValueType.DECIMAL) return false
  if (!(op >= Op.EQ && op <= Op.LTE) || !Number.isInteger(op)) return false
  return t !== ValueType.STRING || op === Op.EQ || op === Op.NEQ
}

/** STRING must be non-empty; INT and DECIMAL must pass the typed parse. */
function isValidTarget(target: string, t: ValueType, decimals: number): boolean {
  if (t === ValueType.STRING) return target.length > 0
  return codeOfThrow(() => parseTyped(target, t, decimals)) === undefined
}

/** The EvalError code a call throws, or undefined when it returns. */
function codeOfThrow(f: () => unknown): string | undefined {
  try {
    f()
    return undefined
  } catch (e) {
    if (e instanceof EvalError) return e.code
    throw e
  }
}

export function allowListed(url: string, allowList: string[]): boolean {
  try {
    const h = hostOf(url)
    return allowList.length > 0 && allowList[0] === h // the Layer 1 host is listed first
  } catch {
    return false
  }
}
