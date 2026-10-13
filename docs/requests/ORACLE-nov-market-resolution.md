# Request to the oracle owners: resolution report for the November testnet market

From: Risk & Clearing / Order Book (unified team). Date: 2026-10-11.

## What we need

Someone who controls the oracle side must run the resolution for the single relaunch market
when Polymarket resolves it. Without a report the market cannot settle; it only voids after
`voidSecs` (30 days after listing, about 10–11 November 2026).

Please confirm, before we list the market:

1. Who will run the oracle services for this market (CRE listener / keeper, panel runner,
   watchdog and committee console, `oracle/services/README.md`), and from which host.
2. Whether the shared settlement actors authorized by `ResolutionOracle` trust set 1
   (`RUNNER_ATTESTOR`, `COMMITTEE_1..3`, `WATCHDOG`, `SIM_RELAYER`; see below) will sign.
3. Monitoring through Polymarket's UMA liveness and any dispute (resolution can lag the
   6–8 November event by days).

## Market

Chosen on 2026-10-11 from Gamma `events?end_date_min=2026-11-06&end_date_max=2026-11-08`.
Candidates (both binary sub-markets, `endDate` 2026-11-07 04:59 UTC, resolution source the CNN
national House exit poll viewed at 12:00 ET on 6 November 2026):

- 4199213 "Will Democrats win white women in the midterms?" (1,000-claim impact spread 0.010)
- 4927096 "Will Republicans win white voters in the midterms?" (spread 0.019)

Selected: **4199213** (Polymarket event 961306; `scheduledT` 1794027540 = 2026-11-07 04:59 UTC),
qualified 2026-10-11 (900 s coverage, 862 valid polls, no failures, worst source gap 20.1 s).

## Resolution path (unchanged, oracle scope)

Standard `oracle/e2e/src/fresh-market.ts` listing: `listing.resolutionAuthority =
ResolutionOracle`; the feed reads Gamma `markets/{id}` and requires
`umaResolutionStatus == resolved`; YES/NO comes from `outcomePrices[yesIndex] == 1`. A split,
fractional or unavailable payout goes to the oracle's review/invalid process and is never treated
as NO. We will not change the feed or the resolution logic.

## Facts we have

- `CLAUDE.md` (2026-10-05) records that no local account controls the existing oracle
  deployment (its owner/admin roles).
- The market setup reuses six settlement actors that the shared `ResolutionOracle` trust set 1
  already authorizes (`SIM_RELAYER`, `RUNNER_ATTESTOR`, `COMMITTEE_1..3`, `WATCHDOG`). Their keys
  are in the git-ignored `tmp/redeploy-audit-20261007/roles.env`, and `setup-markets.mjs` checks
  them against the oracle's `trustSet(1)` before listing. Running the oracle services with these
  keys is an operating decision for the oracle owners or the user; this team does not run them.

Until this request is answered the market can be listed and traded on testnet, but settlement
depends on someone running the resolution.
