/** Real API + CRE CLI evaluation. Read-only: the dryrun workflow has no EVM writes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { keccak256, toBytes } from 'viem'
import { evaluateResponse, buildUrl, MAX_BODY_BYTES } from '../../packages/feedspec/src'
import { sportsFeed, sportsCompanionUrl, type SportsBinding } from '../../packages/feedspec/src/sports'
import { API_SPORTS_AUTH, API_SPORTS_PROVIDERS } from '../../packages/feedspec/src/api-sports'

const root = resolve(import.meta.dir, '../../..')
const [bindingFile, outputInput] = process.argv.slice(2)
if (!bindingFile || !outputInput?.startsWith('tmp/')) throw new Error('Usage: verify-sports-cre.ts <reviewed-binding.json> tmp/<new-run>')
const output = resolve(root, outputInput)
if (existsSync(output)) throw new Error('USE_NEW_EVIDENCE_DIRECTORY')
mkdirSync(output, { recursive: true, mode: 0o700 })
const envPath = resolve(root, 'oracle/workflows/.env')
const key = parseEnv(readFileSync(envPath, 'utf8'))[API_SPORTS_AUTH.env]
if (!key) throw new Error('SPORTSDATA_API_KEY_VALUE_REQUIRED')
const write = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const binding = JSON.parse(readFileSync(resolve(root, bindingFile), 'utf8')) as SportsBinding
const provider = API_SPORTS_PROVIDERS.find(p => p.id === binding.sport)!
const authRef = keccak256(toBytes(provider.authRefLabel))
const feed = sportsFeed(binding, authRef), url = buildUrl(feed)
const report: Record<string, unknown> = { scope: 'real API and CRE CLI dry-run; no chain transactions',
  checkedAt: new Date().toISOString(), binding, passed: false }
try {
  const response = await fetch(url, { headers: { [API_SPORTS_AUTH.header]: key, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(12000) })
  // The API key never appears in URLs, config files, reports or console output.
  const body = await response.text()
  const companionUrl = sportsCompanionUrl(feed)
  let companion: { statusCode: number; body: string; bodyBytes: number } | undefined
  if (companionUrl) {
    const r = await fetch(companionUrl, { headers: { [API_SPORTS_AUTH.header]: key }, redirect: 'error', signal: AbortSignal.timeout(12000) })
    const text = await r.text()
    companion = { statusCode: r.status, body: text, bodyBytes: new TextEncoder().encode(text).length }
    if (companion.bodyBytes <= MAX_BODY_BYTES && !text.includes(key)) writeFileSync(resolve(output, 'provider-companion.json'), text, { mode: 0o600 })
  }
  const result = evaluateResponse(feed, response.status, body, new TextEncoder().encode(body).length, companion)
  report.httpStatus = response.status; report.localEvaluation = result
  if (body.length <= MAX_BODY_BYTES && !body.includes(key)) writeFileSync(resolve(output, 'provider-response.json'), body, { mode: 0o600 })
  if (!['YES', 'NO', 'NOT_READY'].includes(result.status)) throw new Error('LIVE_FIXTURE_VALIDATION_FAILED')
  const config = { schedule: '0 */5 * * * *', httpTimeout: '8s', allowList: [provider.host],
    authSecrets: [{ authRef, secretId: API_SPORTS_AUTH.secretId, header: API_SPORTS_AUTH.header, prefix: API_SPORTS_AUTH.prefix }], feed }
  write('cre-config.json', config)
  const proc = Bun.spawn([process.env.CRE_BIN ?? 'cre', 'workflow', 'simulate', 'dryrun', '--target', 'local-sim',
    '--config', resolve(output, 'cre-config.json'), '--trigger-index', '0', '--limits', 'default',
    '--non-interactive', '-e', envPath], {
    cwd: resolve(root, 'oracle/workflows'), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, [API_SPORTS_AUTH.env]: key },
  })
  const timer = setTimeout(() => proc.kill(), 180000)
  let stdout: string, stderr: string, code: number
  try { [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]) }
  finally { clearTimeout(timer) }
  const log = (stdout + stderr).split(key).join('[REDACTED]')
  writeFileSync(resolve(output, 'cre-simulation.log'), log, { mode: 0o600 })
  const expected = `${result.status}|${result.status === 'NOT_READY' ? '0x' + '00'.repeat(32) : keccak256(toBytes(result.valueLexeme))}|${result.code}`
  report.creExitCode = code; report.expectedResult = expected
  report.passed = code === 0 && log.includes(expected)
  if (!report.passed) throw new Error('CRE_LIVE_EVALUATION_MISMATCH')
  console.log(JSON.stringify({ passed: true, sport: binding.sport, eventId: binding.eventId, predicate: binding.predicate, outcome: result.status, evidence: outputInput }))
} catch (error) {
  const message = (error as Error).message
  report.error = /^[A-Z_]+$/.test(message) ? message : 'SPORTS_VERIFICATION_FAILED'
  console.error(report.error); process.exitCode = 1
} finally { write('report.json', report) }
