// Prompt text from stored bytes. Nothing here is hashed, so it can change without changing any evidenceHash.
// CSS-hidden text is kept; the injection detector flags it from the raw bytes.
import type { Item } from './types'
import { itemBytes } from './fetcher'

const TEXTUAL = /^(text\/|application\/(json|[a-z0-9.+-]*\+json|xml|[a-z0-9.+-]*\+xml|javascript|csv)\b)/

/** From the Content-Type header; UTF-8 when absent or unknown. */
export function decoderFor(contentType: string): TextDecoder {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  try {
    return new TextDecoder(m ? m[1].toLowerCase() : 'utf-8')
  } catch {
    return new TextDecoder('utf-8')
  }
}

const mediaType = (contentType: string) => contentType.split(';')[0].trim().toLowerCase()

/** Null for binary types, failed fetches and empty bodies. */
export function promptText(item: Item): string | null {
  if (item.httpStatus === 0 || item.bytesBase64 === '') return null
  const type = mediaType(item.contentType)
  if (type !== '' && !TEXTUAL.test(type)) return null
  const raw = decoderFor(item.contentType).decode(itemBytes(item))
  if (type === 'text/html' || type === 'application/xhtml+xml' || (type === '' && /^\s*<(!doctype html|html)\b/i.test(raw))) return htmlText(raw)
  return raw
}

// The XML five, the space, and the punctuation sports and data pages commonly use; others are left as written.
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', times: '×', deg: '°', copy: '©', reg: '®',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole
    }
    return ENTITIES[e.toLowerCase()] ?? whole
  })
}

const BLOCK = /^(p|div|br|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|main|nav|aside|blockquote|pre|dd|dt|dl|hr|td|th)$/

/** Drops scripts, styles, comments and tags; block elements become line breaks. */
export function htmlText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<![^>]*>/g, ' ') // doctype and other declarations
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_, tag: string) => (BLOCK.test(tag.toLowerCase()) ? '\n' : ' '))
  return decodeEntities(stripped)
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v ]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n')
}
