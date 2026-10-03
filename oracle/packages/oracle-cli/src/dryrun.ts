// `oracle-cli dryrun` writes dryrun.log and fails on any mismatch:
//  1. burst test: one parallel GET per DON node, all HTTP 200 (a 429 means the provider plan is too small);
//  2. three simulations: the reference event reproduces reference.json, an unfinished event gives NOT_READY, and a
//     wrong value path gives ERROR.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUrl, evaluateResponse, type FeedSpec } from '@eros-oracle/feedspec'
import { keccak256, toBytes } from 'viem'
import { ORACLE_ROOT } from './forge'
import { authSecretsFor, ListError, nodeHeaders, packDir, readListing, ZERO32 } from './list'

/** Returns the workflow's "STATUS|valueHash|code". */
export type Simulate = (configPath: string) => Promise<string>

export type DryRunOptions = {
  input: string
  nodes: number // DON size
  network?: string
  out?: string
  fetchImpl?: typeof fetch
  simulate?: Simulate
  env?: Record<string, string | undefined>
  now?: () => Date
}

export type Run = { name: string; detail: string; expected: string; got: string; pass: boolean }
export type DryRunResult = { dir: string; log: string; pass: boolean; burst: Run; runs: Run[] }

const WRONG_SEGMENT = '__oracle_cli_missing__'

export async function dryRun(o: DryRunOptions): Promise<DryRunResult> {
  const network = o.network ?? 'monad-testnet'
  const input = readListing(o.input)
  if (!input.dryRun) throw new ListError('the listing input has no dryRun.liveUrlParam (an event that is not final yet)')
  if (!Number.isInteger(o.nodes) || o.nodes < 1) throw new ListError('--nodes must be the DON size, a positive integer')
  const dir = packDir(input, o.out)
  const refPath = join(dir, 'reference.json')
  if (!existsSync(refPath)) throw new ListError(`${refPath} is missing: run oracle-cli list first`)

  const feed: FeedSpec = { ...input.marketInput.feed }
  const finished: FeedSpec = { ...feed, urlParam: input.reference.urlParam }
  const live: FeedSpec = { ...feed, urlParam: input.dryRun.liveUrlParam }
  const wrong: FeedSpec = { ...finished, valuePath: `${feed.valuePath}.${WRONG_SEGMENT}` }
  const headers = nodeHeaders(feed.authRef, network, o.env)

  const url = buildUrl(finished)
  const statuses = await Promise.all(
    Array.from({ length: o.nodes }, () =>
      (o.fetchImpl ?? fetch)(url, { headers, signal: AbortSignal.timeout(10_000) }).then(
        async (r) => { await r.arrayBuffer(); return String(r.status) },
        (e) => `FETCH_FAILED(${e instanceof Error ? e.name : 'error'})`,
      ),
    ),
  )
  const counts = new Map<string, number>()
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1)
  const burst: Run = {
    name: 'burst',
    detail: `${o.nodes} parallel GET ${url}`,
    expected: `${o.nodes}x 200`,
    got: [...counts].map(([s, n]) => `${n}x ${s}`).join(', '),
    pass: counts.get('200') === o.nodes,
  }

  const ref = new Uint8Array(readFileSync(refPath))
  const ev = evaluateResponse(finished, 200, new TextDecoder('utf-8').decode(ref).trim(), ref.length)
  if (ev.status !== 'YES' && ev.status !== 'NO') throw new ListError(`reference.json evaluates to ${ev.status}, not YES or NO`)
  const simulate = o.simulate ?? creSimulate
  const configDir = mkdtempSync(join(tmpdir(), 'oracle-cli-dryrun-'))
  const cases: { name: string; spec: FeedSpec; detail: string; expect: (r: string) => boolean; expected: string }[] = [
    {
      name: 'finished', spec: finished, detail: `urlParam ${finished.urlParam}`,
      expected: `${ev.status}|${keccak256(toBytes(ev.valueLexeme))}|OK`,
      expect: (r) => r === `${ev.status}|${keccak256(toBytes(ev.valueLexeme))}|OK`,
    },
    {
      name: 'live', spec: live, detail: `urlParam ${live.urlParam}`,
      expected: `NOT_READY|${ZERO32}|*`, expect: (r) => r.startsWith(`NOT_READY|${ZERO32}|`),
    },
    {
      name: 'wrong-path', spec: wrong, detail: `urlParam ${wrong.urlParam}, valuePath ${wrong.valuePath}`,
      expected: `ERROR|${ZERO32}|*`, expect: (r) => r.startsWith(`ERROR|${ZERO32}|`),
    },
  ]
  const runs: Run[] = []
  for (const c of cases) {
    const path = join(configDir, `config.${c.name}.json`)
    writeFileSync(path, JSON.stringify(dryRunConfig(c.spec, input.marketInput.allowList, network), null, 2))
    let got: string
    try {
      got = await simulate(path)
    } catch (e) {
      got = `SIMULATION_FAILED: ${e instanceof Error ? e.message : String(e)}`
    }
    runs.push({ name: `sim ${c.name}`, detail: c.detail, expected: c.expected, got, pass: c.expect(got) })
  }

  const pass = burst.pass && runs.every((r) => r.pass)
  const marketId = keccak256(toBytes(input.slug))
  const log = [
    `# dryrun.log: oracle-cli dryrun (O22.3), market ${marketId}, ${(o.now?.() ?? new Date()).toISOString()}`,
    `# feed ${feed.urlTemplate} finalPath=${feed.finalPath} finalValue=${feed.finalValue} valuePath=${feed.valuePath} op=${feed.op} target=${feed.target}`,
    ...[burst, ...runs].map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}; expected ${r.expected}; got ${r.got}`),
    `result: ${pass ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n')
  writeFileSync(join(dir, 'dryrun.log'), log)
  return { dir, log, pass, burst, runs }
}

/** Config for workflows/dryrun, with the resolution workflow's authRef table. */
export function dryRunConfig(feed: FeedSpec, allowList: string[], network: string) {
  return { schedule: '0 */5 * * * *', httpTimeout: '8s', allowList, authSecrets: authSecretsFor(network), feed }
}

export const creSimulate: Simulate = async (configPath) => {
  const p = Bun.spawn(
    ['cre', 'workflow', 'simulate', 'dryrun', '--target', 'local-sim', '--limits', 'default',
      '--config', configPath, '--non-interactive', '--trigger-index', '0'],
    { cwd: join(ORACLE_ROOT, 'workflows'), stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return simulationResult(out + err, code)
}

/** The quoted value after "Workflow Simulation Result:". */
export function simulationResult(output: string, exitCode: number): string {
  const lines = output.split('\n')
  const at = lines.findIndex((l) => l.includes('Workflow Simulation Result:'))
  const line = at >= 0 ? lines.slice(at + 1).find((l) => l.trim() !== '') : undefined
  if (exitCode !== 0 || !line) {
    const last = lines.filter((l) => l.trim() !== '').slice(-3).join(' | ')
    throw new Error(`cre exited ${exitCode}${line ? '' : ', no simulation result'}: ${last}`)
  }
  const result = JSON.parse(line.trim())
  if (typeof result !== 'string') throw new Error(`unexpected simulation result ${line.trim()}`)
  return result
}
