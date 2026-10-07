# Fresh Monad testnet deployment

## Recovery and detached restart — 7 October, 17:40 UTC

The frontend and matching Envio indexer now run as detached local processes.
The indexer resumed its existing database and caught up after its old process
stopped; an HTTP-ready GraphQL endpoint alone did not prove active ingestion.
Both market routes passed anonymous browser checks with no application exceptions.

Both operator groups restarted with their existing custody, policies and journals:
Nebraska at 17:36:26 UTC, House at 17:37:07 UTC. Supported recovery reconciled the
expired, never-broadcast publisher reservations (Nebraska nonce 482 / sequence 485;
House nonce 505 / sequence 506). No journals or original signed bytes were cleared.
Fresh price publications resumed around 17:39–17:40 UTC.

The restart fixes add bounded retries for transient simulation/read failures and
validate recovery history with at most eight concurrent workers. All canonical,
signature, nonce and budget checks remain in force. Ten targeted recovery tests,
six watcher-policy tests, a TypeScript build and independent review passed.

At canonical block **69032109** (17:40 UTC), Nebraska had accepted sequence 488
and 33/300 seconds of INDEX coverage; House had sequence 510 and 53/300 seconds.
Source ages were 19 and 18 seconds respectively. Both INDEX and MARK remained
unavailable and both directional caps remained **1×**. Genuine Polymarket YES
order-book observations supply the depth-weighted source price; execution INDEX
requires a fully covered five-minute TWAP. New source timestamp or delivery gaps
can interrupt this window, so approximately 17:45 UTC / 23:15 IST is only an
initial earliest estimate, not a guaranteed readiness time. MARK and leveraged
admission have additional book, basis and epoch requirements.

These operator runs retain their 30-minute bounds and gas/failure limits:
Nebraska ends around **18:06 UTC / 23:36 IST** and House around
**18:07 UTC / 23:37 IST** unless a guard stops them earlier. The frontend and
indexer are detached from the command session and do not share that timer.
No contracts were redeployed, and no commit or push was performed.

Evidence: `artifacts/integration/service-resume-20261007-1718/` and the canonical
read-only checkpoints under the matching ignored `tmp/` directory. Earlier
checkpoints below describe their original times, not current service health.

## Current local restart — 7 October, 16:55 UTC

The frontend was restarted on `http://localhost:3100` using the same verified
production build. The matching indexer remained healthy and was retained. Its
registry, both market identities, chain 10143 and canonical listing receipts
were checked again through the frontend RPC path. Privy login controls, portfolio,
resolution reads and public pages passed anonymous browser checks.

Both publisher/keeper/maker groups resumed their original journals and exact
configuration. House's previous UNKNOWN sequence 399 reconciled the existing
canonical receipt, with the same hash, nonce and attempt count. Nothing was
cleared or resubmitted. The latest pricefeed source was rebuilt, including the
bounded budget-verification fix; seven focused regression tests passed.

Two exact keeper gas transfers finalized: **8 MON to Nebraska and 4 MON to House**.
The deployment wallet retained **3.140462015999727 MON**. Independent review checked
both signed intents and canonical receipts. Current sessions are bounded to
30 minutes and still stop at their existing gas/failure limits:

| Market | Worker start (UTC) | Scheduled end (UTC / IST) |
| --- | --- | --- |
| House | 16:41:34 | 17:11:34 / 22:41:34 |
| Nebraska | 16:49:13 | 17:19:13 / 22:49:13 |

Latest anonymous terminal checks at 16:55–16:56 UTC passed with no application
exceptions and exact comparisons to canonical contract reads. House had an
available 0.075 INDEX; Nebraska's 0.285 source chart was present but its INDEX
window was incomplete. Both source charts correctly labeled delayed observations;
both MARK values remained unavailable and both directional caps were 1×.

At the 16:58 UTC handoff check, both engines again reported an available INDEX.
This is a point-in-time check; genuine upstream timestamp gaps can interrupt
availability. MARK remained unavailable and directional caps remained 1×.

Restarting does not establish continuous MARK or 5× admission. Current price
windows and on-chain caps remain authoritative. The optional one-click trading,
automated protection and claim-delivery services remain unconfigured: the public
Privy App ID supports manual wallet flows, but does not replace their server-side
credentials and separate signing policies. No resolution workflow listener was
activated and no new contract was deployed.

Evidence: `artifacts/integration/service-restart-20261007/`. No commit or push
was performed. The earlier deployment and audit evidence below is historical.

## Audit repair rollout — 7 October 2026, deployed and funded

The user funded the deployment wallet and authorized redeployment and service
funding for frontend testing. The repaired oracle has immutable registry/treasury
bindings, so this rollout creates a fresh connected deployment. Existing markets
and owner balances remain on their original contracts and are retained as archived
frontend deployments.

- Fresh base: all **32 public transactions** finalized and passed runtime and
  reciprocal binding verification. Actual gas cost: **6.905266278 test MON**.
- The address register is refreshed from canonical finalized receipts during the
  rollout. It contains the replacement deployment only.
- The treasury has **22,000 assertion test tokens**, with a 3,336 per-market
  allowance. Both market listings, calibration and activation passed canonical
  verification, with **100,000 reserve test tokens per market**.
- Eight independent runtime wallets received **99 test MON** in total: 39 in the
  initial funding pass and 60 in a separately rehearsed, canonically verified
  top-up. The independent review now covers **83 deployment and funding receipts**.
  Four maker owners each confirmed their own faucet, approval, deposit and allocation
  sequence, allocating **2,000 test tokens per maker**. These are separate from
  the user's wallet and any balances retained in archived deployments.
- The frontend selects the two fresh markets and its production build passed.
  A matching local Envio indexer serves their current deployment at loopback
  port 8083; the frontend runs on port 3100. Public browser checks and continuous
  INDEX/MARK window validation continue. Eleven anonymous browser checks passed
  with zero application exceptions, including both fresh markets, archived
  routing, search, themes, mobile layouts and RPC outage/recovery. Privy login
  controls and a read-only fresh collateral faucet simulation passed; owner
  login and signing remain the user's manual checkpoint.
- Current source probes are recorded separately, including intermittent vendor
  timing and transport failures. No continuous public price coverage or 5× fill
  is claimed by deployment alone. Live publication and admission guards remain
  unchanged.
- The archived-market oracle routing fix passed 70 frontend unit tests, 47
  integration tests, four deployment selection/export checks and typecheck.
  The indexer passed 40 tests, typecheck and code generation. New evidence is in
  `artifacts/integration/redeployment-20261007/`; earlier audit reports retain
  their original source fingerprints.

Local runtime campaigns are explicitly bounded to one hour. Both publishers now
finalize genuine external observations. The House publisher initially stopped
safely after a transient RPC preflight failure, before creating signing journals;
the retry fix passed three Node regression tests (74 assertions), is included by
the existing CI test glob, and its guarded restart succeeded. Deployment has a
5× ceiling; available leverage still depends on fresh INDEX/PERP/BASIS windows
and an eligible epoch. Deployment and funding alone do not establish MARK or 5×
admission. Keep the laptop powered while using these local services.

At 11:55 UTC Nebraska's actual INDEX300, PERP60 and BASIS900 windows were all
available. Its 12:00 UTC transition nevertheless remained in bootstrap: the last
valid sealed book capture was at 11:59:25, and the next sealing transaction landed
after epoch expiry at 12:00:02. Expired accounting made that book quote unavailable,
so it could not promote the pending 11:59:42 capture. Rollover at 12:00:12 correctly
retained the 1× fallback. House's later startup also missed that transition.
The next epoch boundary is 13:00 UTC; it is not a promise of readiness.
This is a measured operator scheduling failure, not a claim that MARK/5× is ready.
Pre-boundary sampler timing and post-rollover maker refresh repairs passed focused
regressions and independent review; contract freshness and admission guards remain
intact. Both restarted with reviewed budget renewals and 30-block sampler cadence:
House at 12:21:32 UTC and Nebraska at 12:46:08 UTC. Nebraska's expired sequence
174, signed but never reserved or sent as a transaction, was reconciled through
the supported packet-store API after full copied-journal verification. No signed
bytes or history were deleted. House also recorded genuine 32/33-second sample
gaps after restart; uninterrupted BASIS900 must be measured, not assumed from uptime.

At 12:45, 36 hash-verified REST observations showed Polymarket repeating the
same authentic timestamp for **34.595 seconds**, beyond the 30-second freshness
limit. This caused a measured five-second INDEX history gap. It was an upstream
update gap, not a missed collection or fabricated frontend zero. Both INDEX values
were available again at 12:52 (Nebraska 0.285, House 0.075), but both actual caps
remained **1×/1×**, and **MARK/public 5× remain unresolved**. The freshness guard
was not weakened. A consistently updating source is required for uninterrupted
public price-window readiness.

Local worker deadlines are **13:21:32 UTC / 18:51:32 IST for House** and
**13:46:08 UTC / 19:16:08 IST for Nebraska**, subject to existing gas and failure
floors. The web server alone does not maintain prices after these workers stop.

At 12:31 UTC, four separately rehearsed transfers recovered **18.13916877 test MON**
from stopped, retired publisher/keeper wallets into the corresponding new keepers.
Old trader wallets, token balances and collateral were untouched. Two independent
test traders also received 1.5 MON each and completed mint, approval, deposit and
allocation with 10 test tokens each. House's independent owner completed actual opening and closing fills, release
and withdrawal with four canonical receipts. It ended flat, with 8.8 test tokens
allocated and 11 in its wallet after a 0.2-token spread loss. This proves fully
backed trading and custody, not 5× or Privy wallet signing. Nebraska's separate
public trader round trip was not executed in this checkpoint. See
[owner flow evidence](../../artifacts/integration/redeployment-20261007/owner-flow.json).

All four GitHub workflows passed on the user-pushed commit `f7e3d35`: contracts,
oracle, pricefeed and frontend. The later local sampler/maker and bounded budget-verification repairs have focused
local test evidence and are not represented as part of that GitHub run.

Private journals and operator custody remain under `tmp/redeploy-audit-20261007/`.
No private key or credential-bearing RPC URL belongs in deployment artifacts.

## Historical checkpoint — earlier 7 October deployment; services stopped

- User supplied 40 test MON; initial verified balance 40.374 MON. Two source probes
  passed: Nebraska independent Senate outcome 634893 and Republican House
  outcome 562803. Their exact identities and finite qualification reports are
  retained; future source continuity remains a live validation gate.
- The two code stores, replacement factory and its shared vault are deployed on
  Monad testnet. Governance authorization and all five canonical receipts now passed.
  Confirmed base-plan cost: **3.543841896 MON**. Both replacement engines are
  deployed and activated, with verified reserve funding and canonical receipts.
  The rebuilt frontend selects both current markets.
- The House rehearsal caught insufficient assertion-bond coverage before any
  deployment transaction. Canonically verified funding increased the test-token
  assertion ledger to **22,000**, with a **3,336** lifetime per-market allowance.
  This covers the three-attempt envelope of **21,016.8** across the resulting
  commitments at current cap bonds. The separate watchdog float is still 100;
  full-cap automatic dispute funding is not claimed. See the
  [treasury evidence](../../artifacts/deployments/monad-testnet-20261007-factory-v4/treasury-funding.json).
- [addresses.md](../../addresses.md) is refreshed after each confirmed deployment,
  with transaction links, blocks and activation status. Local fork addresses are
  excluded. The register lists only the current V1 contracts; historical evidence
  stays in deployment artifacts.
- Publisher latency follow-up passed 474 isolated Linux tests and independent
  Astra review. Fresh matching local backend lifecycle, receipt and source
  integrity checks passed. No 5× public
  fills or continuous public MARK availability are claimed yet.

- At the user's request, all local services and test processes were stopped.
  No automatic restart is scheduled. Public MARK continuity and actual 5×
  fills remain incomplete; see [E2E_PROGRESS.md](E2E_PROGRESS.md).

## Historical v3 checkpoint — before the funded v4 replacement

Two v3 markets replace the earlier engines after the mark-sampling continuity
repair. Both public deployment plans were rehearsed and their canonical receipts,
runtime hashes, listings and factory/vault bindings verified before frontend use.

| Identity | Address |
| --- | --- |
| Current MarketFactory | `0x545afe64D9C462e84107cf623E68dEd5eb4E8D3b` |
| Current CollateralVault | `0x779D71Dd7Ac25981f36B900566F548545B5213a9` |
| Democratic Senate engine | `0x0fC0CB70C1B0bbf9dD8de0eBDF539fFa8b98533E` |
| Republican control engine | `0xdDECC6051b1477b09B693eCD8D1b41a2769E4B87` |

Registry, resolution oracle and test collateral token retain the October 6
addresses below. Public evidence and operator configuration are in
`artifacts/deployments/monad-testnet-20261007-democratic-senate-v3/` and
`artifacts/deployments/monad-testnet-20261007-republican-control-v3/`.
The primary frontend manifest selects these markets; archived manifests retain
older vault/engine identities for existing owner balances. No funds were migrated.

Local publishers, makers, samplers and epoch operators ran bounded test campaigns.
At 23:07 UTC on October 6, they were gracefully drained after reaching gas reserves;
their journals were preserved and no pending transaction remained. A further
sampler fingerprint correction is implemented and under final validation. Its v4
replacement plan is prepared, but no v4 contract has been broadcast. Public
deployment and sustained price-window checks require the requested test MON top-up.

The earlier full contract CI passed 837 tests. Production build and 20 frontend
integration tests passed after the manifest switch; Chrome checks passed in both
themes at 320/768/1024/1440 px. The first market's independent-owner funding and
opening fill have passed. Normal MARK, 5× round trips, the independent Astra audit
and final push remain in progress. See [E2E_PROGRESS.md](E2E_PROGRESS.md) for the
latest completed evidence and limits. Permanent service hosting is still deferred.

## Historical scope — 2026-10-06

The user authorized a fresh deployment of the required contracts using the
private key in the root `.env`, followed by frontend integration and service
setup. Target: Monad testnet, chain 10143. No mainnet deployment or Git push.
Existing historical deployments and their evidence remain archived.

The authorized key derives address
`0xFf49aD13c59592cCCa53552FE09dAcA43cbcF190`. Initial read-only preflight:
26.671441567999748 MON, latest/pending nonce 23, block 68541253. The old
`TESTNET_DEPLOYER` environment entry does not match; derive identity from the key.
No private keys or credential-bearing RPC URLs belong in public manifests.

## Work sequence

| Stage | Status | Acceptance |
| --- | --- | --- |
| Deployment preparation | Complete | Pinned artifacts, explicit roles, journaled plans |
| Fresh local rehearsal | Deployment passed | Full sequence, bindings, receipt and gas checks |
| Public deployment | Complete | 39 finalized deployment/activation transactions, verified public manifest |
| Frontend wiring | Implemented; browser/build checks pass | SDK owner calls, dynamic caps, canonical receipts, deployment/history guards |
| Operator setup | Configured; hosting deferred | Public pins, encrypted publisher custody, funded roles, preserved journals |
| End-to-end trading demo | Not ready | Custody passed; continuous prices, real fills and live Privy signing still required |

## Inputs and boundaries

- User selected a real Polymarket event. Source qualification passed 120 observations
  over 120.87 seconds, 21 advancing timestamps, maximum advance gap 11.633 seconds.
  First event: "US announces end of Iranian blockade by October 31, 2026?"
- User has no running services and asked to set up hosting after the wiring.
- Test collateral and synthetic calibration must be labeled separately from any
  authentic external prices. Existing local fixture proof does not establish
  complete authentic-source leveraged operation.
- The oracle testnet sandbox and simulation delivery must retain explicit labels;
  no CRE network deployment or production UMA/DVM is implied.
- Deployment authorization supersedes the older local-only scope notes for this
  work. Existing immutable deployments will not be modified merely to reuse them.

## Completed base deployment

All 32 public transactions finalized and passed canonical receipt, runtime and
reciprocal binding checks at block 68544977. Receipt gas cost: 6.897323538 MON.
The five-minute timelock delay was preserved. The deployer owns proposer,
executor, canceller, lister and guardian roles; operator keys are separate and
stored only in the ignored owner-only run directory. These are testnet EOA roles,
not a claim of multisig governance. No stub factory or test MockUSDC was deployed.

| Contract | Address |
| --- | --- |
| MarketRegistry | `0x9bE1d595Ac9B6c1109a4dcaa056CE5eFDAF06F45` |
| ResolutionOracle | `0x2085DaD31c8Ee03025DD07a4EdC103401d493D87` |
| MarketFactory | `0xE348249c130ed49E33b024495477F81d40244F4D` |
| CollateralVault | `0xB544Cc0f81E587924f819258b3061a28F4954D4B` |
| TestUSDC | `0x0e0279B152845972479c66f933835c92582E1dC4` |

Evidence: `tmp/fresh-testnet-20261006/base-plan.json`,
`broadcast-journal.json`, `base-verification.json`, and the distinct local
`rehearsal-journal.json` / `rehearsal-verification.json` in the same directory.
Public sanitized artifacts are exported in `artifacts/deployments/monad-testnet-20261006/`.

Five deployment-runner regression tests and its focused TypeScript check pass.
All 109 FeedSpec tests pass after adding explicit array-index traversal through
JSON-encoded arrays, needed for Gamma's outcomePrices field. The selected feed
requires `umaResolutionStatus=resolved` and an integer payout; fractional payouts
fail evaluation instead of resolving NO. The resolution CRE workflow's 12 tests,
typecheck and WASM build pass. This is build/unit evidence, not a new CRE CLI run.

## Fresh market and frontend

- Engine: `0xcDf0EA81497895155E2911443f46157c00F965Db`.
- Market: `0xb75d77f847ad7eb057bc9249d711cdf235fabb941fe4586776f79653cc50cea4`.
- Public market listing block: 68546673. The full canonical listing hash is in the
  public manifest; the local rehearsal's listing hash differs and is not selected.
- The reserve holds 100,000 test tokens. Deployment ceiling is 5×; live directional
  caps initially read 1× because pricing is not ready. The exact synthetic profile
  is published with its verified hash; no empirical risk calibration is claimed.
- All 39 deployment/activation receipts cost 10.10233296 test MON in total.
  Separate native transfers funded publisher (1.5 MON), keeper (0.75 MON), and
  two independent maker wallets (0.35 MON each). Transfers to owned operator
  wallets are not counted as gas cost.
- Both owners completed faucet → approval → deposit → allocation on testnet,
  each allocating 2,000 test tokens. The same browser SDK builders are used by
  the UI. These key-controlled SDK checks do not certify interactive Privy signing.
- A first market-listing preflight exceeded the 30M gas ceiling after padding.
  It sent no public market transaction. Compacting duplicated description text
  made the second, independently rehearsed plan fit without weakening the margin.
  Original plans and journals remain in the ignored run directory.
- A bounded public epoch rollover finalized using one page, with a measured 421,732
  gas estimate and 516,079 gas limit. It preserved price-readiness restrictions.
- A local release rehearsal returned rejection code 11 (pricing unavailable); no
  public release/withdrawal was sent. The funding balances remain allocated.
- A local maker-order rehearsal correctly emitted `OrderRejected(11)` because
  pricing was unavailable. No public fill is claimed. A later local funding step
  encountered an epoch boundary, completed after a journaled local rollover, and
  both public owner custody sequences then passed.

Frontend changes select the verified factory deployment, refresh ABIs, use the
browser SDK for owner transactions, read actual `leverageCaps()`, offer integer
1–5× sizing, and require exact canonical finalized receipts before dependent
steps. Runtime hashes, chain, listing identities and contract bindings are checked.
A matching indexer binding is required before history is enabled. Test-token minting
is available with explicit wallet confirmation. Old manual-fixture/1× disclosures
were replaced with the actual external-source/synthetic-risk/testnet-oracle labels.

## External source and CRE evidence

The five-minute bounded public publisher run initially recorded 9/12 finalized
observations, then stopped at its configured time limit. Its last submitted
transaction was reconciled from the same journal on restart: 10 finalized total,
no unresolved signed transaction. Source and packet journal integrity checks pass.
`services/publication-check.json` preserves the original result;
`publication-reconciliation.json` records recovery without creating a replacement
transaction. Several observation gaps exceeded 30 seconds (maximum 51 seconds).
This does **not** satisfy the contiguous INDEX300 window or establish PERP60,
BASIS900, normal pricing, 5× admission or a leveraged fill. Hosting alone is not
proof: cadence and actual contract readiness must be measured after activation.

CRE CLI 1.36.0 successfully simulated the new Polymarket FeedSpec, performing the
external HTTP request and returning `NOT_READY/NOT_FINAL`, as expected for this
ongoing event. Evidence is in `services/cre-feed-simulation.*`. This run wrote
nothing on chain. The fresh resolution workflow target and listener configuration
are prepared; no live CRE DON workflow or finalized new-market resolution is claimed.
Earlier completed CRE/settlement evidence remains historical, with its original scope.

## Validation

- Pinned deployment-runner tests: 5 pass / 61 assertions; focused TypeScript passes.
- Affected oracle, SDK, FeedSpec, CRE and market-ops tests: 248 pass. The first run
  used the unpinned system Forge and crashed during ABI inspection; the rerun with
  Foundry 1.8.3 passes, including all source/snapshot ABI checks.
- Envio fresh configuration code generation and typecheck pass; all 38 indexer
  tests pass. No new hosted GraphQL endpoint has been provisioned.
- Frontend unit tests: 35 pass. Integration tests: 12 pass, including account
  switching, exact receipt finality, RPC identity, code/binding mismatches and reorgs.
- Production build and browser checks pass: main pages, all terminal tabs, light/
  dark layout at 320/768/1024/1440px; no overflow, browser runtime errors or failed
  resources in the recorded run. Axe found no A/AA/2.1AA violations in the loaded
  dark desktop terminal. The Privy login dialog opened with email/wallet options. Real authenticated Privy signing is still a manual demo gate.
- Clean Node 22 `npm ci` is checked locally with the repository's existing peer
  dependency setting retained. GitHub has not run these unpushed changes.

## Remaining work, in order

1. Choose and activate a persistent host, as requested after wiring. Transfer
   private operator custody and existing journals securely; never reinitialize
   the publisher with the same signer. See `FRESH_TESTNET_SERVICES.md`.
2. Improve and measure source-to-chain delivery so contiguous price windows become
   available. Run book sampling and epoch maintenance with funded maker liquidity;
   verify actual previews and caps before demonstrating 1–5× trading.
3. Finish future-state keeper/liquidation gas enrollment and supervise the separate
   keeper, CRE listener and optional panel/committee roles. The current event has
   not resolved, so its actual outcome and settlement cannot be demonstrated yet.
4. Host the matching Envio indexer; connect its read-only GraphQL endpoint using
   the frontend's chain/registry binding. Current state works directly from RPC.
5. Run real embedded and external wallet login/signing, an admitted order and fill,
   cancellation, release/withdrawal, then record the bounty demo. Optional delegated
   trading/protection also requires server-side Privy credentials and separate policies.

The root `.env` public address aliases were updated to the verified contracts; its
private key was preserved. A scan of changed files and 202 browser JS bundles
found none of the deployment/operator private keys.

Nothing has been committed or pushed. Hosting remains deferred by the user.

## Frontend audit follow-up — 2026-10-06

The user requested a frontend wiring audit before continuing live E2E. Findings,
fixes and the validation boundary are in [FRONTEND_WIRING_AUDIT.md](FRONTEND_WIRING_AUDIT.md),
with machine-readable evidence in `artifacts/integration/frontend-audit-20261006/report.json`.

Current results: 39 unit tests, 18 integration tests, TypeScript and the production
build pass. Chrome checks pass across 50 page/theme/width combinations and all nine
terminal tabs; ten accessibility scans find no A/AA/2.1AA violations. RPC outage
recovery, blocked browser storage, cookie controls, route errors and finalized
receipt display are checked. No browser runtime exceptions remain in the final runs.

The audit repairs deployment/owner binding, transaction sequencing/finality,
history pagination, invalid price observations, stale-state gating, margin display
and wallet startup under storage restrictions. Optional server signing retains
separate policy/credential requirements. Real wallet authentication/signing, fills,
continuous price readiness and a matching hosted indexer still need E2E validation.
No public transactions, commits or pushes were made during this audit.
