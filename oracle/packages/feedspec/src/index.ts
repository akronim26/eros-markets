// FeedSpec evaluator (Oracle spec §5.2; plan §7.3, Appendix B.2; task O20.1). Pure TypeScript, no Node or
// browser APIs, no runtime dependency, no floats on numeric values. Shared by the CRE workflow, the watchdog
// and the listing dry-run CLI.
//
// O20.1 change to B.2: `buildUrl` first checks the template exactly as the registry's `HostLib.checkTemplate`
// does (https, host, then `{id}` at most once and after the first '/' that follows the host), then the
// urlParam, so a FeedSpec the registry refuses is refused here too and in the same order (ADJ-12).

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

// ---------------------------------------------------------------- URL + host (steps 1-2)

/** The request URL: the template checked as the registry checks it, then `{id}` replaced by urlParam. */
export function buildUrl(spec: FeedSpec): string {
  checkTemplate(spec.urlTemplate)
  if (!URL_PARAM_RE.test(spec.urlParam)) throw new EvalError('BAD_URL_PARAM')
  const url = spec.urlTemplate.replace(ID, () => spec.urlParam) // a function: no '$' patterns
  hostOf(url)
  return url
}

/**
 * The registry's template rules (`HostLib.checkTemplate`, BadFeed codes 1-3, in that order): https,
 * host, then `{id}` at most once and, if present, after the first '/' at or after the end of the host.
 */
export function checkTemplate(template: string): void {
  hostOf(template) // NOT_HTTPS, BAD_HOST
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

/** Index of the first '/', '?' or '#' after the scheme, else the length (the host's end). */
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
    i++ // opening quote
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

// ---------------------------------------------------------------- typed parse (step 7)

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
  if (n.k === 'num' || n.k === 'str') return n.v // number or numeric string
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

// ---------------------------------------------------------------- full evaluation (steps 4-8)

export function evaluateResponse(spec: FeedSpec, statusCode: number, body: string, bodyBytes: number): Evaluation {
  try {
    if (statusCode < 200 || statusCode > 299) return { status: 'ERROR', code: `HTTP_${statusCode}`, valueLexeme: '' }
    if (bodyBytes > MAX_BODY_BYTES) return { status: 'ERROR', code: 'BODY_TOO_LARGE', valueLexeme: '' }
    const root = parseJson(body)
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

export function allowListed(url: string, allowList: string[]): boolean {
  try {
    const h = hostOf(url)
    return allowList.length > 0 && allowList[0] === h // Layer 1 host is listed first
  } catch {
    return false
  }
}
