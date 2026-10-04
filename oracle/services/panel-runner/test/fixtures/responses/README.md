# Provider responses for the model-client tests

Each file is `{httpStatus, headers, body}`: one HTTP response as a provider sends it. These were **constructed** in
each provider's documented response format (Anthropic Messages, OpenAI-compatible chat completions as OpenAI and
Groq return them, Gemini `generateContent`), because no provider API key was available when O33.1 was written
(3 Oct 2026). `bun run record` (scripts/record.ts) sends one real panel call per configured model and saves the raw
responses under `../recorded/`; the tests then also run every recorded response through the same parser.

Recorded on 3 Oct 2026 (`test/fixtures/recorded/`): `groq:openai/gpt-oss-120b@2026-10-03`, `nvidia:moonshotai/kimi-k3@2026-10-03` and `google:gemini-3.8-flash@2026-10-03`, each HTTP 200 with a valid YES answer, plus one real Gemini 503 ("high demand") from the first attempt.
