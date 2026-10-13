// Evidence for one scenario run: every step with its transaction, block and chain time, written as it happens to
// docs_oracle/evidence/OG3/<scenario>/run.json, and a summary table to README.md when the run ends.
import { ORACLE_ROOT } from '@eros-oracle/oracle-sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { pc } from './stack'
import { engineConfig } from './engine'

type Step = { step: string; market?: Hex; tx?: Hex; block?: string; time?: string; detail?: unknown }

const bigints = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)

export class Evidence {
  readonly dir: string
  readonly steps: Step[] = []
  readonly checks: { check: string; ok: boolean; detail: string }[] = []
  private started = new Date().toISOString()

  constructor(readonly scenario: string, readonly title: string) {
    if (engineConfig.kind === 'book-risk' && !process.env.E2E_OUTPUT_DIR) throw new Error('Real-engine runs require a distinct E2E_OUTPUT_DIR; historical stub evidence is preserved')
    this.dir = join(process.env.E2E_OUTPUT_DIR ?? join(ORACLE_ROOT, '..', 'docs_oracle/evidence/OG3'), scenario)
    mkdirSync(this.dir, { recursive: true })
    // A resumed run (E2E_APPEND=1) keeps the steps of the run it continues; its checks are made again.
    const prev = join(this.dir, 'run.json')
    if (process.env.E2E_APPEND === '1' && existsSync(prev)) {
      const old = JSON.parse(readFileSync(prev, 'utf8')) as { steps: Step[]; started: string }
      this.steps.push(...old.steps)
      this.started = old.started
    }
  }

  log(m: string) {
    console.log(`[${this.scenario}] ${new Date().toISOString().slice(11, 19)} ${m}`)
  }

  async step(step: string, o: { market?: Hex; tx?: Hex; detail?: unknown } = {}) {
    const s: Step = { step, ...o }
    if (o.tx) {
      const r = await pc.getTransactionReceipt({ hash: o.tx })
      const b = await pc.getBlock({ blockNumber: r.blockNumber })
      s.block = r.blockNumber.toString()
      s.time = new Date(Number(b.timestamp) * 1000).toISOString()
    }
    this.steps.push(s)
    this.log(`${step}${o.tx ? ` ${o.tx}` : ''}`)
    this.flush('running')
  }

  check(check: string, ok: boolean, detail: string) {
    this.checks.push({ check, ok, detail })
    this.log(`${ok ? 'PASS' : 'FAIL'} ${check}: ${detail}`)
    this.flush('running')
  }

  flush(status: string) {
    const doc = { scenario: this.scenario, title: this.title, network: 'monad-testnet', engineKind: engineConfig.kind, status, started: this.started, steps: this.steps, checks: this.checks }
    writeFileSync(join(this.dir, 'run.json'), JSON.stringify(doc, bigints, 2) + '\n')
  }

  finish(error?: unknown) {
    const ok = !error && this.checks.length > 0 && this.checks.every((c) => c.ok)
    const status = error ? `error: ${String(error).split('\n')[0]}` : ok ? 'pass' : 'fail'
    this.flush(status)
    const rows = this.steps.map((s) => `| ${s.step} | ${s.market ? `\`${s.market.slice(0, 10)}…\`` : ''} | ${s.tx ? `\`${s.tx}\`` : ''} | ${s.block ?? ''} | ${s.time ?? ''} |`)
    const checks = this.checks.map((c) => `| ${c.ok ? 'PASS' : 'FAIL'} | ${c.check} | ${c.detail} |`)
    const md = [
      `# ${this.scenario}: ${this.title}`,
      '',
      `Monad testnet, run started ${this.started}. Status: **${status}**. Driven by \`oracle/e2e\` (\`bun e2e/src/main.ts ${this.scenario}\`) against the deployed oracle and the running keeper, panel runner, watchdog, indexer and CRE listener; full record in run.json.`,
      '',
      '| Step | Market | Tx | Block | Time (UTC) |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
      '| Result | Check | Detail |',
      '| --- | --- | --- |',
      ...checks,
      '',
    ].join('\n')
    writeFileSync(join(this.dir, 'README.md'), md)
    this.log(`finished: ${status}`)
    return ok
  }
}
