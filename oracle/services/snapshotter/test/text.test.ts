// Task O32.1: prompt text is extracted from the stored bytes and never replaces them (plan §8.2).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { itemBytes, takeSnapshot } from '../src/fetcher'
import { htmlText, promptText } from '../src/text'
import type { Item } from '../src/types'
import { L1_JSON, startFixture, STATS_HTML } from './fixture'

let fx: ReturnType<typeof startFixture>
beforeAll(() => {
  fx = startFixture()
})
afterAll(() => fx.stop())

async function items(...urls: string[]): Promise<Item[]> {
  const s = await takeSnapshot({ marketId: '0x01', allowList: ['api.example-sports.com', 'stats.example-data.org'], pages: urls }, { fetchFn: fx.fetchFn })
  return s.items
}

describe('promptText', () => {
  test('HTML: visible text only, entities decoded, blocks on their own lines; the item keeps the raw page', async () => {
    const [html] = await items('https://stats.example-data.org/match/1')
    expect(promptText(html)).toBe("Final score\nHome 3 – Away 1 & that's it\nAttendance: 41,000")
    expect(Buffer.from(itemBytes(html)).toString()).toBe(STATS_HTML)
  })

  test('JSON and plain text pass through; the charset is honoured', async () => {
    const [json, latin1] = await items('https://api.example-sports.com/v1/events/evt_1', 'https://stats.example-data.org/latin1')
    expect(promptText(json)).toBe(L1_JSON)
    expect(promptText(latin1)).toBe('café')
  })

  test('no text for binary types, failed fetches and empty bodies', async () => {
    const [png, moved] = await items('https://stats.example-data.org/logo.png', 'https://stats.example-data.org/moved')
    expect(promptText(png)).toBeNull()
    expect(promptText(moved)).toBeNull() // 302 with an empty body
    expect(promptText({ ...png, httpStatus: 0, contentType: '', bytesBase64: '', error: 'NETWORK' })).toBeNull()
  })
})

describe('htmlText', () => {
  test('comments, scripts, styles, noscript and template are dropped; unknown entities are kept', () => {
    expect(htmlText('<p>a<!-- b --></p><noscript>c</noscript><template>d</template><p>e &bogus; &#0; f</p>')).toBe('a\ne &bogus; &#0; f')
  })
  test('inline tags join words with a space, block tags break lines', () => {
    expect(htmlText('<ul><li>one <b>two</b></li><li>three</li></ul>')).toBe('one two\nthree')
  })
})
