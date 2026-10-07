# Market replacement — 6 October 2026

## Current state — October 7 update

The frontend now selects two verified v3 markets: Democratic Senate control and
Republican control, both referencing real Polymarket events on November 3. The
replacement factory is `0x545afe64D9C462e84107cf623E68dEd5eb4E8D3b` and its vault is
`0x779D71Dd7Ac25981f36B900566F548545B5213a9`. Verified deployment evidence is under
`artifacts/deployments/monad-testnet-20261007-{democratic-senate,republican-control}-v3/`.
Both engines have a configured ceiling of 5×. Their current directional caps still
depend on authentic prices, reserves and epoch readiness. Final normal-mark and
leveraged round-trip checks are in progress; see [E2E_PROGRESS.md](E2E_PROGRESS.md).

The new immutable engine fixes rejected-capture continuity after fills or epoch
changes while retaining the original 30-second accepted-price expiry. Old markets
are archived, and previous verified manifests preserve their original custody
bindings. Archives do not migrate funds or guarantee release when old pricing is
unavailable. Local publishers, samplers, keepers and independent maker wallets run
bounded campaigns; permanent hosting remains a separate operational step.

## Earlier replacement history — October 6

The Iran blockade demo is archived in frontend metadata. Markets and the landing
page no longer advertise it. Its verified identity and terminal remain available
through Portfolio. Archived tickets enforce reduce-only orders; flat accounts
cannot fund new exposure. Collateral funding for existing positions, order
cancellation, release, withdrawal and eventual claims retain contract checks.
Archival does not delete the contract, settle it, migrate balances, or guarantee
that collateral is releasable while pricing is unavailable.

The old publisher, market-ops and maker processes were stopped. Their journals
were preserved. No on-chain delisting, halt or replacement deployment was sent.

## Rejected candidate — 2028 election (historical)

The election below was initially selected for source activity, then rejected by
the deployment rehearsal. The deployed registry itself limits listings to about
30 days. Changing a preparer flag cannot extend that limit. The user chose a
compatible shorter event instead; no replacement transaction was broadcast.

[Will JD Vance win the 2028 US Presidential Election?](https://polymarket.com/event/presidential-election-winner-2028/will-jd-vance-win-the-2028-us-presidential-election)

- Polymarket market: `561229`; scheduled election: 7 November 2028.
- Gamma end timestamp: `2028-11-08T04:59:00Z`. This timestamp does not guarantee
  final resolution: the published rules require election calls or inauguration.
- Discovery snapshot: approximately $179,927 in 24-hour volume and $464,795 in
  reported liquidity. These are observations, not future guarantees.
- 420 successful book captures; maximum observed vendor age 1.098 seconds;
  95th percentile 0.748 seconds. All captured books passed the existing
  1,000-claim impact-depth and 0.05-spread checks. Maximum impact spread was 0.001.
- The House and Fed alternatives exhibited 30.8- and 33.9-second book ages.

The original ten-minute qualification **did not pass its uninterrupted-window
gate**. All four streams share an approximately 128-second capture gap, and the
longest continuous JD Vance observation segment was 421.3 seconds. Its source
behavior during the missing interval is unknown. Selection is based on the
observed freshness/depth. A subsequent uninterrupted ten-minute source check
passed, but the contract horizon still makes this candidate ineligible.

Public identities, original qualification results, captured-data hash, leverage
read and browser results are in
[`artifacts/deployments/market-replacement-20261006`](../../artifacts/deployments/market-replacement-20261006/selection.json).
Raw captures remain under `tmp/market-replacement-20261006/`.

## Leverage: configured ceiling versus available leverage

At finalized block 68735247 the old engine's listing cap was **5×**, while
`leverageCaps()` returned **1× long / 1× short**. INDEX and mark were unavailable.
Its active profile was version 2. This is a live pricing/bootstrap restriction,
not a permanent 1× deployment ceiling.

`BookRiskEngine` initializes uncalibrated risk at 1× and returns 1× when inactive,
halted, without a valid mark, or within the full-backing time window. Once its
calibration and price gates are satisfied, `MarginMath.directionalCap` permits:

| Template | Long ceiling | Short ceiling |
| --- | --- | --- |
| Scheduled | 5× | 5× |
| Continuous | 3× | 3× |
| Deadline | 3× | 1× |
| Unscheduled / uncalibrated | 1× | 1× |

The deployment cap can lower these ceilings. Order previews, margin and reserve
coverage can admit less. The ticket already offers integer sizing from 1× to 5×
subject to the actual directional cap.

## Before deployment — historical checkpoint

At this checkpoint no replacement was deployed. The `fresh-market.ts` preparer rejects
events more than 29 days away, within the deployed registry's immutable horizon.
Near-term candidates were screened, but their vendor freshness or impact-spread
checks failed. Do not bypass those checks or present a 5× ceiling as live 5×
admission. Retain the archived engine for existing owners.

The user approved testing **Polymarket reference prices plus direct football
results through CRE**. Three authenticated live CRE CLI evaluations passed and
matched historical Polymarket outcomes. See [FOOTBALL_CRE_TEST.md](FOOTBALL_CRE_TEST.md)
for exact evidence, exception-policy limits, required governance configuration
and the remaining listing and settlement validation. These tests do not deploy
a new market or prove a continuous live INDEX/mark feed.

After deployment, start the matching publisher, makers, sampler, keeper and
indexer. Prove INDEX300, PERP60, BASIS900 and the epoch transition. Only the
resulting on-chain caps and previews establish usable leverage. Future real-event
settlement must remain separate from historical API replay and local lifecycle
test evidence.

## Frontend verification

- Typecheck passed.
- 42 unit checks and 18 integration checks passed.
- Production Webpack build passed; local server restarted on port 3100.
- Chrome: Markets omits the archived event; landing handles zero active markets;
  archived terminal opens; reduce-only is enforced; collateral controls remain.
- No page exceptions during those browser checks. No wallet signatures requested.
- No commit or push performed.
