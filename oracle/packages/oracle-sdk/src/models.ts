// Model API requests shared by the listing CLI's ambiguity pass (O22.3) and the panel runner (O33.1): one chat call
// per model, temperature 0, JSON output, the provider's response text. A model is "provider:model-id@version"
// (§8.3); the API is called with model-id, and `modelIdHash = keccak256("provider:model-id@version")`.
// Moved here from oracle-cli in O33.1 so both use one provider table.
import { type Hex, keccak256, stringToBytes } from 'viem'

export type ModelCall = { system: string; user: string }
export type CallModel = (model: string, call: ModelCall) => Promise<string>

export class ModelError extends Error {}

export const KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY', mistral: 'MISTRAL_API_KEY', cerebras: 'CEREBRAS_API_KEY', nvidia: 'NVIDIA_API_KEY',
}
const PROVIDERS = Object.keys(KEYS).join(', ')
/** Output budget, reasoning included: reasoning models spend part of it before they answer. */
const MAX_OUTPUT_TOKENS = 8192
const GEMINI_MAX_OUTPUT_TOKENS = 32768
/** OpenAI-compatible chat completions: the base URL, the name of the seed field, and whether to ask for the
 *  provider's JSON mode. Groq's JSON mode rejects some gpt-oss answers with json_validate_failed and returns
 *  nothing; without it the answer still has to pass parseUndecided, so nothing invalid gets through. */
const CHAT: Record<string, { url: string; seed: string; jsonMode: boolean; maxField: string; maxTokens: number }> = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', seed: 'seed', jsonMode: true, maxField: 'max_completion_tokens', maxTokens: MAX_OUTPUT_TOKENS },
  // Groq counts the prompt plus this budget against the free tier's 8,000 tokens per minute for gpt-oss-120b.
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', seed: 'seed', jsonMode: false, maxField: 'max_completion_tokens', maxTokens: 6000 },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', seed: 'random_seed', jsonMode: true, maxField: 'max_tokens', maxTokens: MAX_OUTPUT_TOKENS },
  // Cerebras's free tier has capped context at 8,192 tokens (prompt plus output).
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', seed: 'seed', jsonMode: true, maxField: 'max_completion_tokens', maxTokens: 4096 },
  // NVIDIA build (hosted NIM): JSON mode is not offered for every model, so the answer is checked by parseUndecided.
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', seed: 'seed', jsonMode: false, maxField: 'max_tokens', maxTokens: MAX_OUTPUT_TOKENS },
}

/**
 * Temperature per API model id: 0 (the panel's rule, §8.3) unless a model degenerates at 0. Kimi K3 on NVIDIA
 * returned an empty answer and a reasoning trace of "!!!!" at 0 and answers normally at its recommended 1.0
 * (tested 3 Oct 2026). Every run records the temperature it used in ambiguity.log.
 */
const TEMPERATURE: Record<string, number> = { 'moonshotai/kimi-k3': 1.0 }
export const temperatureFor = (model: string) => TEMPERATURE[parseModel(model).id] ?? 0

/** `keccak256("provider:model-id@version")` (§8.3), the value pinned in a market's `ai.modelIdHashes`. */
export function modelIdHash(model: string): Hex {
  parseModel(model) // refuses anything but "provider:model-id@version"
  return keccak256(stringToBytes(model))
}

export function parseModel(model: string): { provider: string; id: string; version: string } {
  const m = /^([a-z0-9-]+):([^@\s]+)@(\S+)$/.exec(model)
  if (!m) throw new ModelError(`bad model "${model}": expected "provider:model-id@version"`)
  return { provider: m[1], id: m[2], version: m[3] }
}

/**
 * Structured-output options (O33.1): `schema` is a JSON schema the answer must follow, sent as OpenAI's strict
 * `json_schema` response format where the provider enforces it (OpenAI); everywhere else the caller validates the
 * answer against it. `seed` is sent to Gemini (the chat providers always get seed 0).
 */
export type RequestOptions = { schema?: { name: string; schema: object }; seed?: number }

/** The HTTP request for one call (exported for tests). */
export function modelRequest(model: string, call: ModelCall, key: string, opts: RequestOptions = {}): { url: string; init: RequestInit } {
  const { provider, id } = parseModel(model)
  const json = (url: string, headers: Record<string, string>, body: unknown) => ({
    url, init: { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
  })
  switch (provider) {
    case 'anthropic':
      return json('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
        model: id, max_tokens: MAX_OUTPUT_TOKENS, temperature: temperatureFor(model), system: call.system, messages: [{ role: 'user', content: call.user }],
      })
    case 'openai':
    case 'groq':
    case 'mistral':
    case 'cerebras':
    case 'nvidia':
      return json(CHAT[provider].url, { authorization: `Bearer ${key}` }, {
        model: id, temperature: temperatureFor(model), [CHAT[provider].seed]: 0, [CHAT[provider].maxField]: CHAT[provider].maxTokens,
        ...(provider === 'openai' && opts.schema
          ? { response_format: { type: 'json_schema', json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema } } }
          : CHAT[provider].jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: call.system }, { role: 'user', content: call.user }],
      })
    case 'google':
      return json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent`, { 'x-goog-api-key': key }, {
        systemInstruction: { parts: [{ text: call.system }] },
        contents: [{ role: 'user', parts: [{ text: call.user }] }],
        // Gemini's thinking tokens count against maxOutputTokens: 8,192 cut 3.8 Flash off before it answered.
        generationConfig: {
          temperature: temperatureFor(model), responseMimeType: 'application/json', maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        },
      })
    default:
      throw new ModelError(`no client for provider "${provider}" (${PROVIDERS})`)
  }
}

/** The text of a provider's response body; an answer stopped by the token limit is an error, not an answer. */
export function responseText(provider: string, body: any): string {
  const stop =
    provider === 'anthropic' ? body?.stop_reason
    : provider in CHAT ? body?.choices?.[0]?.finish_reason
    : provider === 'google' ? body?.candidates?.[0]?.finishReason
    : undefined
  if (stop === 'max_tokens' || stop === 'length' || stop === 'MAX_TOKENS') {
    throw new ModelError(`${provider} answer cut off at the output token limit`)
  }
  const text =
    provider === 'anthropic' ? (body?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    : provider in CHAT ? body?.choices?.[0]?.message?.content
    : provider === 'google' ? (body?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
    : undefined
  if (typeof text !== 'string' || text === '') throw new ModelError(`empty response from ${provider}`)
  return text
}

/** Waits before retry n (0-based): the provider's Retry-After when it sends one, else 5 s, 15 s, 45 s; at most 60 s. */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const secs = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 5 * 3 ** attempt
  return Math.min(secs, 60) * 1000
}

