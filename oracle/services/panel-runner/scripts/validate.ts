// `bun run validate`: the panel's validation run (plan §10, tasks O39.3-O39.5) on the pilot sample that
// oracle/validation/gate/sample.py writes. For each candidate, in sample order, until each (category, split) has its
// quota: a snapshot of the URLs the rules cite (the snapshotter, cited hosts as the allow-list), then the three panel
// models with the category's pinned prompt, exactly as the runner asks them (askPanel). A candidate whose snapshot
// holds no fetchable allow-listed page is recorded as NO_EVIDENCE and costs no model call; the next spare takes its
// place. On the holdout, when the panel's majority label is a known outcome other than the official one, the watchdog
// model is asked too (its miss rate f, §10 step 5).
//
// Paid calls (AICredits) report their cost in rupees; the run stops before a candidate once the total reaches
// VALIDATION_BUDGET_INR (default 20, ADJ-46). Records are appended to gate/runs/panel.jsonl (resumable: a market
// already recorded is skipped) and snapshots kept under gate/runs/snapshots/; both stay local (ADJ-39).
//
//   bun --env-file=../../../.env scripts/validate.ts
import { askWatchdogModel, modelSignal, WATCHDOG_MODEL, watchdogCall } from '../../watchdog/src/model'
import { canonicalBytes, evidenceHash, type Snapshot, takeSnapshot } from '@eros-oracle/snapshotter'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { askPanel, buildCall, type Category, loadPrompts } from '../src'

export const PANEL = ['groq:openai/gpt-oss-120b@2026-10-03', 'nvidia:moonshotai/kimi-k3@2026-10-03', 'aicredits:google/gemini-3.8-flash@2026-10-04']
const QUOTA: Record<string, number> = { train: 2, calibration: 3, holdout: 3 }

const RUNS = new URL('../../../validation/gate/runs/', import.meta.url).pathname
const OUT = join(RUNS, 'panel.jsonl')
const SNAPSHOTS = join(RUNS, 'snapshots')
const budget = Number(process.env.VALIDATION_BUDGET_INR ?? '20')

type Candidate = {
  split: string; category: Category; rank: number; parent_id: string; market_id: string
  question: string; rules: string; closed_at: string; outcome: 'YES' | 'NO'; pages: string[]; allowList: string[]
}

let spent = 0
/** fetch that adds up the rupee cost AICredits reports in each response's usage. */
const metered: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await fetch(input, init)
  if (String(input).startsWith('https://api.aicredits.in/')) {
    const body = await res.clone().json().catch(() => null)
    const c = body?.usage?.cost_details
    spent += Number(c?.prompt_cost_inr ?? 0) + Number(c?.completion_cost_inr ?? 0)
  }
  return res
}) as typeof fetch

const usable = (s: Snapshot) => s.items.some((it) => it.allowListed && it.httpStatus >= 200 && it.httpStatus < 300)
const tau = (closedAt: string) => Math.floor(Date.parse(closedAt.replace(' ', 'T').replace(/\+00$/, 'Z')) / 1000)

const sample: Candidate[] = readFileSync(join(RUNS, 'sample.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const done = new Map<string, { split: string; category: string; status: string }>()
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)) { const r = JSON.parse(l); done.set(r.market_id, r); spent += r.costInr ?? 0 }
mkdirSync(SNAPSHOTS, { recursive: true })
const prompts = loadPrompts()

for (const c of sample) {
  const filled = [...done.values()].filter((r) => r.split === c.split && r.category === c.category && r.status === 'RUN').length
  if (done.has(c.market_id) || filled >= QUOTA[c.split]) continue
  if (spent >= budget) {
    console.log(`budget reached: ₹${spent.toFixed(2)} of ₹${budget}; stopping`)
    break
  }
  const snapshot = await takeSnapshot({ marketId: c.market_id, allowList: c.allowList, pages: c.pages })
  const evHash = evidenceHash(snapshot)
  writeFileSync(join(SNAPSHOTS, `${evHash}.json`), canonicalBytes(snapshot))
  const base = {
    split: c.split, category: c.category, rank: c.rank, parent_id: c.parent_id, market_id: c.market_id, truth: c.outcome, evidenceHash: evHash,
    items: snapshot.items.map((it) => ({ url: it.url, httpStatus: it.httpStatus, allowListed: it.allowListed, bytes: Buffer.from(it.bytesBase64, 'base64').length })),
  }
  if (!usable(snapshot)) {
    const r = { ...base, status: 'NO_EVIDENCE', costInr: 0 }
    appendFileSync(OUT, JSON.stringify(r) + '\n')
    done.set(c.market_id, r)
    console.log(`${c.split} ${c.category} ${c.market_id}: no fetchable allow-listed page`)
    continue
  }
  const prompt = prompts.find((p) => p.category === c.category)!
  const before = spent
  const call = buildCall(prompt, { question: c.question, rules: c.rules, tau: tau(c.closed_at) }, snapshot)
  const outcomes = await askPanel(PANEL, call, snapshot.items, { fetchFn: metered })
  const labels = outcomes.map((o) => o.label)
  const majority = labels.find((l) => labels.filter((x) => x === l).length >= 2)
  let watchdog: unknown
  if (c.split === 'holdout' && (majority === 'YES' || majority === 'NO' || majority === 'INVALID') && majority !== c.outcome) {
    const m = { question: c.question, rules: c.rules, tau: BigInt(tau(c.closed_at)), hasFeed: false }
    const asked = await askWatchdogModel(WATCHDOG_MODEL, watchdogCall(m, snapshot), { fetchFn: metered })
    watchdog = { model: WATCHDOG_MODEL, signal: modelSignal(asked, snapshot) }
  }
  const r = {
    ...base, status: 'RUN', promptHash: prompt.promptHash, costInr: spent - before,
    outcomes: outcomes.map((o) => ({ model: o.model, label: o.label, confidence: o.confidence, cited: o.cited, abstainReason: o.abstainReason ?? null, httpStatuses: o.attempts.map((a) => a.httpStatus), rationale: o.rationale })),
    ...(watchdog ? { watchdog } : {}),
  }
  appendFileSync(OUT, JSON.stringify(r) + '\n')
  done.set(c.market_id, r)
  console.log(`${c.split} ${c.category} ${c.market_id} truth ${c.outcome}: ${outcomes.map((o) => `${o.label}${o.confidence === null ? '' : `@${o.confidence}`}`).join(' ')} (₹${(spent - before).toFixed(2)}, total ₹${spent.toFixed(2)})`)
}
console.log(`spent ₹${spent.toFixed(2)}`)
