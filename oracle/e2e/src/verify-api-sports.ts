/** Probe only the explicitly registered providers; never print account details or keys. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'
import { keccak256, toBytes } from 'viem'
import { API_SPORTS_AUTH, API_SPORTS_PROVIDERS } from '../../packages/feedspec/src/api-sports'

const root = resolve(import.meta.dir, '../../..'), output = resolve(root, process.argv[2] ?? '')
if (!output.startsWith(resolve(root, 'tmp') + sep)) throw new Error('IGNORED_OUTPUT_DIRECTORY_REQUIRED')
if (existsSync(output)) throw new Error('USE_NEW_EVIDENCE_DIRECTORY')
const key = parseEnv(readFileSync(resolve(root, 'oracle/workflows/.env'), 'utf8'))[API_SPORTS_AUTH.env]
if (!key) throw new Error('SPORTSDATA_API_KEY_VALUE_REQUIRED')
mkdirSync(output, { recursive: true, mode: 0o700 })
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
type Access = { id: string; host: string; checkedAt: string; accessible: boolean; httpStatus?: number
  plan?: string; active?: boolean; requestsUsed?: number; dailyLimit?: number; error?: string }
const results: Access[] = []
// Two requests in flight; one /status request per provider, no retries or fixture scans.
for (let index = 0; index < API_SPORTS_PROVIDERS.length; index += 2) {
  const pair = API_SPORTS_PROVIDERS.slice(index, index + 2)
  const checked = await Promise.all(pair.map(async provider => {
    const result: Access = { id: provider.id, host: provider.host, checkedAt: new Date().toISOString(), accessible: false }
    try {
      const response = await fetch(`https://${provider.host}/status`, {
        headers: { accept: 'application/json', [API_SPORTS_AUTH.header]: key },
        redirect: 'error', signal: AbortSignal.timeout(12000),
      })
      result.httpStatus = response.status
      const body = await response.text()
      if (body.length > 65536) throw new Error('BODY_TOO_LARGE')
      const data = JSON.parse(body)
      if (!response.ok) result.error = `HTTP_${response.status}`
      else if (!data.errors || typeof data.errors !== 'object' || Object.keys(data.errors).length) result.error = 'PROVIDER_ERROR'
      else {
        const subscription = data.response?.subscription, requests = data.response?.requests
        result.active = subscription?.active === true
        // /status also contains personal account details: never persist its raw body.
        if (typeof subscription?.plan === 'string' && subscription.plan.length <= 32 && !subscription.plan.includes(key)) result.plan = subscription.plan
        if (Number.isSafeInteger(requests?.current)) result.requestsUsed = requests.current
        if (Number.isSafeInteger(requests?.limit_day)) result.dailyLimit = requests.limit_day
        result.accessible = result.active && typeof result.dailyLimit === 'number' && result.dailyLimit > 0
        if (!result.accessible) result.error = 'SUBSCRIPTION_NOT_ACTIVE_OR_UNKNOWN'
      }
    } catch { result.error = 'FETCH_OR_RESPONSE_FAILED' }
    return result
  }))
  results.push(...checked)
  for (const result of checked) console.log(JSON.stringify(result))
  save('access-report.json', { scope: 'Authenticated /status access only; no sport result or settlement validation',
    checkedAt: new Date().toISOString(), passed: results.every(r => r.accessible), complete: results.length === API_SPORTS_PROVIDERS.length, providers: results })
}
// These are reusable inputs. Exporting them does not authorize hosts/authRefs on chain
// or activate any workflow. Each market still has its own source allow-list.
save('cre-auth.json', { authSecrets: API_SPORTS_PROVIDERS.map(provider => ({
  authRef: keccak256(toBytes(provider.authRefLabel)), secretId: API_SPORTS_AUTH.secretId,
  header: API_SPORTS_AUTH.header, prefix: API_SPORTS_AUTH.prefix,
})) })
save('watchdog-auth.json', Object.fromEntries(API_SPORTS_PROVIDERS.map(provider => [
  keccak256(toBytes(provider.authRefLabel)), { header: API_SPORTS_AUTH.header, env: API_SPORTS_AUTH.env },
])))
save('providers.json', API_SPORTS_PROVIDERS.map(provider => ({ ...provider,
  baseUrl: `https://${provider.host}`, authRef: keccak256(toBytes(provider.authRefLabel)),
})))
if (results.some(r => !r.accessible)) process.exitCode = 1
