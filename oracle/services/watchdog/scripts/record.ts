// `bun run record`: records the watchdog model's real answers on two fixed snapshots of the example market (3-1, so
// YES; 1-1, so NO) into test/fixtures/. Request headers, and so the API key, are never written.
import { KEYS, modelRequest, parseModel } from '@eros-oracle/oracle-sdk'
import { canonicalBytes, takeSnapshot } from '@eros-oracle/snapshotter'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WATCHDOG_MODEL, watchdogCall } from '../src/model'

const ROOT = fileURLToPath(new URL('../test/fixtures/', import.meta.url))
export const MARKET = {
  id: '0xe085067fb3e1eba632de103ba472329d833cddefdb9296cc70569d9b080d5fcf',
  question: 'Will the home team score more than 2 goals?',
  rules: 'YES if the final home score is above 2; NO otherwise. INVALID if the match is not played.',
  tau: 1_791_046_043n,
  hasFeed: true,
}
export const SCENARIOS = {
  'home-3-1': { home: 3, away: 1 },
  'home-1-1': { home: 1, away: 1 },
} as const

export function scenarioSnapshot(name: keyof typeof SCENARIOS) {
  const { home, away } = SCENARIOS[name]
  const pages: Record<string, () => Response> = {
    'https://api.example-sports.com/v1/events/evt_1': () => Response.json({ event: { status: 'FINAL', home, away } }),
    'https://stats.example-data.org/match/evt_1': () =>
      new Response(`<html><body><h1>Full time: Home ${home}-${away} Away</h1><p>Status: FT</p></body></html>`, { headers: { 'content-type': 'text/html' } }),
  }
  const fetchFn = (async (u: string) => pages[u]()) as unknown as typeof fetch
  return takeSnapshot(
    { marketId: MARKET.id, l1Url: 'https://api.example-sports.com/v1/events/evt_1', allowList: ['api.example-sports.com', 'stats.example-data.org'], pages: ['https://stats.example-data.org/match/evt_1'] },
    { fetchFn, clock: () => 1_791_046_400 },
  )
}

if (import.meta.main) {
  const model = process.env.WATCHDOG_MODEL ?? WATCHDOG_MODEL
  const { provider, id } = parseModel(model)
  const key = process.env[KEYS[provider] ?? '']
  if (!key) {
    console.error(`set ${KEYS[provider] ?? `a key for ${provider}`}`)
    process.exit(1)
  }
  mkdirSync(join(ROOT, 'recorded'), { recursive: true })
  for (const name of Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]) {
    const snap = await scenarioSnapshot(name)
    writeFileSync(join(ROOT, 'snapshots', `${name}.json`), canonicalBytes(snap))
    const { url, init } = modelRequest(model, watchdogCall(MARKET, snap), key)
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(300_000) })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {}
    const headers = Object.fromEntries(['content-type', 'retry-after'].flatMap((h) => (res.headers.get(h) !== null ? [[h, res.headers.get(h)]] : [])))
    const file = join(ROOT, 'recorded', `${provider}__${id.replace(/[^a-zA-Z0-9.-]+/g, '_')}__${name}.json`)
    writeFileSync(file, JSON.stringify({ model, scenario: name, recordedAt: new Date().toISOString(), httpStatus: res.status, headers, body }, null, 2) + '\n')
    console.log(`${model} ${name}: HTTP ${res.status} → ${file}`)
  }
}
