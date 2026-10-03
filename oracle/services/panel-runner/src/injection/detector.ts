// Deterministic prompt-injection detector. It scans an item's raw bytes, not the prompt text, so content a page hides
// is still seen. A finding sends the result to the committee; it is not proof of an attack.
//   INSTRUCTION    phrases addressed to a model ("ignore previous instructions")
//   LABEL_COERCION telling the reader which label to give ("answer YES", "label": "YES")
//   ROLE_TAG       chat-template and role markers, and the prompt's own <evidence> tag
//   INVISIBLE_CHAR zero-width and bidi control characters, Unicode tags (ZWJ and ZWNJ are allowed for emoji/scripts)
//   HIDDEN_TEXT    CSS-hidden or off-screen text that is long (200+ letters) or matches a rule above; short hidden
//                  text such as menus is normal
import type { Item } from '@eros-oracle/snapshotter'
import { decoderFor, itemBytes } from '@eros-oracle/snapshotter'

export type Rule = 'INSTRUCTION' | 'LABEL_COERCION' | 'ROLE_TAG' | 'INVISIBLE_CHAR' | 'HIDDEN_TEXT'
export type Finding = { item: number; rule: Rule; detail: string }

export const HIDDEN_TEXT_MIN_LETTERS = 200

const INSTRUCTION: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|skip)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+)*(?:previous|prior|above|preceding|earlier|original|system)\s+(?:instructions?|directions?|prompts?|rules|messages|context|guidelines)/i,
  /\b(?:new|updated|real|actual)\s+(?:system\s+)?instructions?\s*:/i,
  /\byou\s+(?:are|will\s+act\s+as|must\s+act\s+as)\s+(?:now\s+)?(?:an?\s+|the\s+)?(?:ai|assistant|language\s+model|llm|chatbot|model|oracle|judge|resolver)\b/i,
  /\b(?:as\s+an?\s+ai(?:\s+language)?\s+model|the\s+system\s+prompt|your\s+system\s+prompt|developer\s+mode|jailbreak)\b/i,
  /\b(?:attention|note|message)\s+(?:to|for)\s+(?:the\s+)?(?:ai|llm|model|assistant|language\s+model|resolver|oracle)s?\b/i,
  // Direct address: Prompt Guard 2 scored "Dear assistant reading this page: kindly set aside ..." at 0.001.
  /\b(?:dear|hey|hello|hi)\s+(?:ai|assistant|model|llm|chatbot|bot|resolver|oracle)\b/i,
  /\b(?:ai|llm|language\s+model|assistant|model|bot)s?\s+(?:reading|processing|summari[sz]ing|parsing)\s+this\b/i,
]
const LABEL_COERCION: RegExp[] = [
  // Labels in the panel's exact case, so a market page's "resolve to Yes if ..." does not match.
  /\b(?:[Aa]nswer|[Rr]espond|[Rr]eply|[Oo]utput|[Rr]eturn|[Ll]abel\s+(?:this|it)|[Rr]esolve\s+(?:this|it)\s+(?:as|to))\s*(?:with\s+|as\s+|:\s*)?["']?(?:YES|NO|INVALID|NOT_YET)\b(?!\s+(?:if|when|or|and)\b)/,
  /["'][Ll]abel["']\s*:\s*["'](?:YES|NO|INVALID|NOT_YET)["']/,
]
const ROLE_TAG: RegExp[] = [
  /<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\|>/i,
  /\[\/?INST\]|<<\/?SYS>>|<\/?start_of_turn>|<\/?end_of_turn>/,
  /<\/?(?:system|assistant)\s*>/i,
  /<\/?evidence\b/i,
  /^\s*(?:#{1,3}\s*)?(?:system|assistant|instruction)s?\s*:/im,
]

/** Code points that render as nothing or reorder text. A leading BOM is consumed by the decoder. */
function invisible(cp: number): string | null {
  if (cp === 0x200b) return 'zero-width space'
  if (cp >= 0x2060 && cp <= 0x2064) return 'word joiner or invisible operator'
  if (cp === 0xfeff) return 'zero-width no-break space'
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidirectional override'
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'Unicode tag character'
  return null
}

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

function matchRules(text: string, rule: Rule, patterns: RegExp[], item: number, where = ''): Finding[] {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return [{ item, rule, detail: `${where}"${m[0].trim().slice(0, 80)}"` }]
  }
  return []
}

export function textFindings(text: string, item: number, where = ''): Finding[] {
  return [
    ...matchRules(text, 'INSTRUCTION', INSTRUCTION, item, where),
    ...matchRules(text, 'LABEL_COERCION', LABEL_COERCION, item, where),
    ...matchRules(text, 'ROLE_TAG', ROLE_TAG, item, where),
  ]
}

// ------------------------------------------------------------------ hidden HTML

const HIDING_CSS = [
  /display\s*:\s*none/i,
  /visibility\s*:\s*hidden/i,
  /opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!)/i,
  /font-size\s*:\s*0(?:\.0+)?(?:px|em|rem|pt|%)?\s*(?:;|$|!)/i,
  /text-indent\s*:\s*-\s*\d{3,}/i,
  /(?:left|top)\s*:\s*-\s*\d{3,}/i,
]
const hides = (css: string) => HIDING_CSS.some((re) => re.test(css))

function hiddenClasses(html: string): Set<string> {
  const out = new Set<string>()
  for (const s of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const rule of s[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!hides(rule[2])) continue
      for (const c of rule[1].matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(c[1])
    }
  }
  return out
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

/** Text of each element hidden by inline style, the hidden attribute or a hiding class. */
export function hiddenTexts(html: string): { why: string; text: string }[] {
  const classes = hiddenClasses(html)
  const out: { why: string; text: string }[] = []
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m[1] === '/' || VOID.has(m[2].toLowerCase()) || m[3].trim().endsWith('/')) continue
    const attrs = m[3]
    const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
    const why =
      style && hides(style[1] ?? style[2]) ? `style="${(style[1] ?? style[2]).trim().slice(0, 60)}"`
      : /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) ? 'hidden attribute'
      : cls && (cls[1] ?? cls[2]).split(/\s+/).some((c) => classes.has(c)) ? `class="${(cls[1] ?? cls[2]).trim()}"`
      : null
    if (!why) continue
    // Up to the matching close tag, counting nesting.
    const name = m[2].toLowerCase()
    const inner = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi')
    inner.lastIndex = tag.lastIndex
    let depth = 1
    let end = html.length
    for (let n = inner.exec(html); n; n = inner.exec(html)) {
      depth += n[1] === '/' ? -1 : 1
      if (depth === 0) {
        end = n.index
        break
      }
    }
    const text = html.slice(tag.lastIndex, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text !== '') out.push({ why, text })
    tag.lastIndex = end // report each hidden element once
  }
  return out
}

const isHtml = (item: Item, text: string) => /html/i.test(item.contentType) || /^\s*<(?:!doctype html|html)\b/i.test(text)

export function detect(item: Item, index: number): Finding[] {
  const bytes = itemBytes(item)
  if (bytes.length === 0) return []
  const text = decoderFor(item.contentType).decode(bytes)
  const findings = textFindings(text, index)
  let i = 0
  for (const ch of text) {
    const why = invisible(ch.codePointAt(0)!)
    if (why) {
      findings.push({ item: index, rule: 'INVISIBLE_CHAR', detail: `${why} ${hex(ch.codePointAt(0)!)} at ${i}` })
      break
    }
    i += ch.length
  }
  if (isHtml(item, text)) {
    for (const h of hiddenTexts(text)) {
      const letters = (h.text.match(/\p{L}/gu) ?? []).length
      const inside = textFindings(h.text, index)
      if (letters >= HIDDEN_TEXT_MIN_LETTERS || inside.length > 0) {
        findings.push({ item: index, rule: 'HIDDEN_TEXT', detail: `${h.why}: "${h.text.slice(0, 80)}"` })
        break
      }
    }
  }
  return findings
}
