// Minimal client for the ambiguity pass (O22.3): one chat call per model, temperature 0, JSON output, retried on
// 429/5xx. The provider table and request shapes live in oracle-sdk (shared with the panel runner, O33.1).
import { KEYS, ModelError, modelRequest, parseModel, responseText, retryDelayMs, type CallModel } from '@eros-oracle/oracle-sdk'

export { type CallModel, ModelError, type ModelCall, modelRequest, parseModel, responseText, retryDelayMs, temperatureFor } from '@eros-oracle/oracle-sdk'

const PROVIDERS = Object.keys(KEYS).join(', ')

/** Calls the provider's API, retrying 429 and 5xx up to 3 times with back-off (free tiers throttle hard). */
export function httpModelClient(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch, sleep = Bun.sleep): CallModel {
  return async (model, call) => {
    const { provider } = parseModel(model)
    const keyName = KEYS[provider]
    if (!keyName) throw new ModelError(`no client for provider "${provider}" (${PROVIDERS})`)
    const key = env[keyName]
    if (!key) throw new ModelError(`set ${keyName} to call ${model}`)
    const { url, init } = modelRequest(model, call, key)
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(300_000) }) // thinking models can take minutes
      if (r.ok) return responseText(provider, await r.json())
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await r.arrayBuffer()
        await sleep(retryDelayMs(attempt, r.headers.get('retry-after')))
        continue
      }
      throw new ModelError(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
    }
  }
}
