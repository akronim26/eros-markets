# Football results through CRE — 6 October 2026

## Result

Three **real authenticated API-Football calls through the CRE CLI** passed. Each
CLI run compiled the existing dry-run workflow and independently fetched the
fixture using a CRE secret. These were completed historical matches, not a new
market deployment. No blockchain transactions were sent by these tests.

| Question | Fixture | Regular-time score | CRE | Final Polymarket payout |
| --- | --- | --- | --- | --- |
| France to beat Belgium, 5 October | 1528944 | 4–1 | YES | YES |
| Belgium to beat France, 5 October | 1528944 | 1–4 | NO | NO |
| Northern Ireland to beat Georgia, 5 October | 1528947 | 0–0 | NO | NO |

The fixture IDs, team IDs, competition, season, kickoff, external condition IDs
and YES-token IDs are recorded in the
[credential-free evidence](../../artifacts/integration/football-cre-20261006/report.json).
The exact CRE logs, config hashes, binary hashes and result hashes are retained
beside that report. CLI timestamps use the local simulator's formatting; the
report's `checkedAt` is UTC.

## Implementation

`oracle/packages/feedspec/src/football.ts` implements the explicit
`football-regulation-v1` adapter for:

```
https://v3.football.api-sports.io/fixtures?id={id}
```

It consumes the raw provider response inside CRE. It does not use an application
server to invent or relay a result. `erosFootball.status` and
`erosFootball.winner` are versioned adapter fields, not fields supplied by the
provider. The immutable FeedSpec target commits to:

```
football-regulation-v1:fixtureId:leagueId:season:homeTeamId:awayTeamId:kickoff:HOME|AWAY
```

The shared evaluator is used by the resolution workflow, dry-run workflow,
listing checks and watchdog. It checks the requested fixture, both teams,
competition, season, scheduled timestamp, one-result response, provider error
envelope and regular-time final score. Only `FT` with internally consistent
scores and winner flags produces YES/NO. Evidence hashes include fixture
identity and both scores. A draw is NO for either team's win market.

Live, postponed, cancelled, abandoned, awarded, extra-time and penalty-shootout
statuses produce no automatic outcome. Missing or contradictory data, changed
fixtures/schedules, quota errors and malformed responses also produce no report.
The oracle's existing escalation/review path remains necessary for exceptions.
This first adapter does not implement draw-selection markets or knockout winners.

## Tests

- FeedSpec suite: **117 passed** (includes the new football cases).
- Resolution workflow suite: **14 passed**, including authenticated requests,
  exact chain/oracle/market/spec binding, correct report payloads and rejection
  of invalid football responses. These report-delivery checks use CRE SDK mocks.
- Dry-run workflow suite: **10 passed**.
- Actual CRE CLI: **3 passed** using live provider responses and the configured key.
- Typechecks: FeedSpec, both workflows and E2E tooling.

The mocked report-delivery tests and real CLI evaluation are separate evidence.
They do **not** certify a football market's deployed oracle finalization, payout,
live price windows or 5× trade admission.

## Reproduce a live CLI check

Put an API-Football key in ignored `oracle/workflows/.env` as
`SPORTSDATA_API_KEY_VALUE`. Keep it out of public manifests and frontend env.
The workflow secret name is `SPORTSDATA_API_KEY`; the HTTP header is
`x-apisports-key`. The new adapter uses the auth reference
`keccak256("EROS_API_FOOTBALL_V1")`.

Create a reviewed binding file with numeric `fixtureId`, `leagueId`, `season`,
`homeTeamId`, `awayTeamId`, `kickoff` (Unix seconds), and `selection` (`HOME` or
`AWAY`). A tested binding is included in each public report. From repository root:

```sh
bun --no-env-file oracle/e2e/src/verify-football-cre.ts \
  tmp/reviewed-football-binding.json tmp/football-cre-new-run
```

This uses the existing `dryrun` workflow and `local-sim` secrets target. It never
passes `--broadcast`. Each run uses one direct verification fetch plus the CRE
simulator's HTTP fetches. The supplied account reported an active free plan with
100 requests/day. Production DON execution and retries need a separate quota
budget; a free account is not an unlimited live results service.

## Required before a new football listing

1. Choose a future fixture within the deployed registry's horizon. Verify its
   exact Polymarket condition, YES token, teams, kickoff and regular-time rules.
   A sports data key provides **results**, not a healthy probability INDEX.
   The tested upcoming football books had stale vendor timestamps; none is
   certified for continuous INDEX/mark coverage or 5× trading.
2. Publish the resolution and exception policy. Polymarket's cancellation,
   postponement and 50/50 fallback rules are not automatically reproduced by a
   successful ordinary-match comparison. Route these cases to review; do not
   present the sources as universally equivalent.
3. Authorize `v3.football.api-sports.io` and the football auth reference through
   registry governance. Configure the same secret mapping in the resolution
   and watchdog services. No public authorization was sent in this test.
4. For the initial pre-match policy, set market T to kickoff. The builder uses a
   two-hour buffer and six-hour L1 timeout. Existing globals permit only a
   ten-minute buffer and one-hour timeout; governance must extend those bounds
   before listing. Those are configurable values, not a reason to replace the
   core contracts. Simulate the exact governance/listing calls first.
5. Bind the selected API fixture to the new listing's FeedSpec and tau. The
   existing `fresh-market.ts` still prepares a **Polymarket-payout** listing;
   it must not be used unchanged to claim direct football settlement.
6. Validate actual report delivery, assertion/challenge/finality and settlement
   preparation on an isolated chain, then the authorized testnet deployment.
   Keep the CRE simulator and production DON deployment scopes explicit.

The existing risk lifecycle switches new commitments to full backing 12.5 hours
before T. Consequently, this configuration can offer conditional 5× exposure
earlier before a match; it does not promise 5× in-play trading. That is a separate
protocol policy decision, not something a football API key changes.

Provider references: [API-Football documentation](https://www.api-football.com/documentation-v3)
and [plan limits](https://www.api-football.com/pricing).
