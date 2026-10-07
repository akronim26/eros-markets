# API-Sports provider catalog

All ten providers below authenticated with the existing shared token on
6 October 2026. Each `/status` response reported HTTP 200, an active Free
subscription and a daily limit of 100 requests. This verifies account access;
competition/season coverage and individual result endpoints require separate checks.

| Sport | HTTPS API host | Result adapter |
| --- | --- | --- |
| Football | `v3.football.api-sports.io` | `football-regulation-v1`, live CRE evaluation tested |
| Baseball | `v1.baseball.api-sports.io` | Pending |
| Formula 1 | `v1.formula-1.api-sports.io` | Pending |
| Handball | `v1.handball.api-sports.io` | Pending |
| Hockey | `v1.hockey.api-sports.io` | Pending |
| MMA | `v1.mma.api-sports.io` | Pending |
| NBA | `v2.nba.api-sports.io` | Pending |
| American football | `v1.american-football.api-sports.io` | Pending |
| Rugby | `v1.rugby.api-sports.io` | Pending |
| Volleyball | `v1.volleyball.api-sports.io` | Pending |

The shared catalog lives in
[`api-sports.ts`](../../oracle/packages/feedspec/src/api-sports.ts). The football
verification tool consumes it, and the access checker exports credential-free
authentication configuration for every provider.

## Credentials

- Environment: ignored `oracle/workflows/.env`, `SPORTSDATA_API_KEY_VALUE`.
- CRE secret: `SPORTSDATA_API_KEY` (existing `secrets.yaml` mapping).
- Request header: `x-apisports-key`, with no prefix.
- Each provider has its own public auth reference derived from its catalog label.
  They all resolve to the same secret; the football reference is preserved.

No secret belongs in a provider URL, public artifact or frontend environment.

## Verify access again

From the repository root, using a new ignored output directory:

```sh
bun --no-env-file oracle/e2e/src/verify-api-sports.ts tmp/api-sports-new-check
```

The command makes one authenticated `/status` request per provider, with at most
two requests in flight. It records only subscription and quota fields, never the
personal account information also returned by `/status`. It exports:

- `access-report.json`: exact access results and timestamps.
- `providers.json`: provider identities, hosts, auth references and adapter status.
- `cre-auth.json`: entries for a workflow's `authSecrets` array.
- `watchdog-auth.json`: the watchdog's `FEED_AUTH` mapping.

[Recorded access evidence](../../artifacts/integration/api-sports-20261006/access-report.json)
and the generated configurations are retained in the same artifact directory.
The E2E TypeScript check and `git diff --check` passed.

## Activation boundary

These are catalog and authentication inputs. They do not list new markets,
authorize providers in the on-chain registry or activate a broadcasting service.
Each listing needs exact event identity, a pinned source, sport-specific finality
and result rules, and the corresponding provider/auth-reference governance calls.
Each market's source allow-list should contain its intended providers.

Do not reuse football's final-status or regular-time rules for another sport.
For example, overtime, shootouts, no-contests, race classification and abandoned
games require their own outcome handling. The historical MLB public-data adapter
also does not establish support for this API-Sports baseball endpoint.

See [the football CRE evidence](FOOTBALL_CRE_TEST.md) for the result-validation and
settlement boundaries of the currently implemented adapter.

## Shared rules implementation

The provider catalog now selects `sports-v1`. See [SPORTS_RULES.md](SPORTS_RULES.md)
for supported predicates, provider-specific finality checks, CRE/watchdog use and
the live-validation boundaries. The earlier access report remains historical; its
null adapter fields describe the state before the shared framework was added.
