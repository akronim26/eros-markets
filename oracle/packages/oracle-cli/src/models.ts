// Minimal clients for the ambiguity pass (O22.3): one chat call per model, temperature 0, JSON output. The
// panel runner's own clients (O33.1) add the pinned panel prompts, citations, calibration and signing.
// A model is "provider:model-id@version" (§8.3); the API is called with model-id.

export type ModelCall = { system: string; user: string }
export type CallModel = (model: string, call: ModelCall) => Promise<string>

export class ModelError extends Error {}

const KEYS: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' }

export function parseModel(model: string): { provider: string; id: string; version: string } {
  const m = /^([a-z0-9-]+):([^@\s]+)@(\S+)$/.exec(model)
  if (!m) throw new ModelError(`bad model "${model}": expected "provider:model-id@version"`)
  return { provider: m[1], id: m[2], version: m[3] }
}

/** The HTTP request for one call (exported for tests). */
export function modelRequest(model: string, call: ModelCall, key: string): { url: string; init: RequestInit } {
  const { provider, id } = parseModel(model)
  const json = (url: string, headers: Record<string, string>, body: unknown) => ({
    url, init: { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
  })
  switch (provider) {
    case 'anthropic':
      return json('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
        model: id, max_tokens: 4096, temperature: 0, system: call.system, messages: [{ role: 'user', content: call.user }],
      })
    case 'openai':
      return json('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${key}` }, {
        model: id, temperature: 0, seed: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: call.system }, { role: 'user', content: call.user }],
      })
    case 'google':
      return json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent`, { 'x-goog-api-key': key }, {
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: 'user', parts: [{ text: call.user }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      })
    default:
      throw new ModelError(`no client for provider "${provider}" (anthropic, openai, google)`)
  }
}

/** The text of a provider's response body. */
export function responseText(provider: string, body: any): string {
  const text =
    provider === 'anthropic' ? (body?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    : provider === 'openai' ? body?.choices?.[0]?.message?.content
    : provider === 'google' ? (body?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
    : undefined
  if (typeof text !== 'string' || text === '') throw new ModelError(`empty response from ${provider}`)
  return text
}

/** Calls the provider's API, retrying 429 and 5xx up to 3 times with back-off (1 s, 2 s, 4 s). */
export function httpModelClient(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch, sleep = Bun.sleep): CallModel {
  return async (model, call) => {
    const { provider } = parseModel(model)
    const keyName = KEYS[provider]
    if (!keyName) throw new ModelError(`no client for provider "${provider}" (anthropic, openai, google)`)
    const key = env[keyName]
    if (!key) throw new ModelError(`set ${keyName} to call ${model}`)
    const { url, init } = modelRequest(model, call, key)
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(120_000) })
      if (r.ok) return responseText(provider, await r.json())
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await sleep(1000 * 2 ** attempt)
        continue
      }
      throw new ModelError(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
    }
  }
}
