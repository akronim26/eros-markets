// `bun run record:classifier`: records Prompt Guard 2's real answers for every chunk of the injection fixtures into
// test/fixtures/injection/classifier-recorded.json, keyed by chunk sha256, for offline replay.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { CLASSIFIER_MODEL, chunks } from '../src/injection/classifier'
import { evidenceTexts, loadPrompts } from '../src/prompts'
import { fixtureSnapshot } from '../test/fixtures/injection/load'

const OUT = new URL('../test/fixtures/injection/classifier-recorded.json', import.meta.url).pathname
const key = process.env.GROQ_API_KEY
if (!key) throw new Error('set GROQ_API_KEY')
const prompt = loadPrompts().find((p) => p.category === 'sports')!
const answers: Record<string, string> = {}
const snap = fixtureSnapshot()
for (const t of evidenceTexts(snap, prompt)) {
  for (const c of chunks(t.text ?? '')) {
    const h = createHash('sha256').update(c).digest('hex')
    if (answers[h] !== undefined) continue
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'meta-llama/llama-prompt-guard-2-86m', messages: [{ role: 'user', content: c }] }),
      })
      if (res.ok) {
        answers[h] = ((await res.json()) as any).choices[0].message.content
        break
      }
      if (attempt >= 3) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      await Bun.sleep(3000)
    }
  }
}
writeFileSync(OUT, JSON.stringify({ model: CLASSIFIER_MODEL, recordedAt: new Date().toISOString(), answers }, null, 2) + '\n')
console.log(`${Object.keys(answers).length} chunks → ${OUT}`)
