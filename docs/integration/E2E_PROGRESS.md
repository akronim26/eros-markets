# E2E progress — current checkpoint: 7 October 2026

## Stopped at the user's request (7 October 2026)

- All local project services, public transaction workers, indexers, local chains,
  test browsers, health monitors and audit agents were stopped. No automatic
  restart is scheduled. Durable signing journals and local run evidence remain
  preserved; reconcile them before any future restart.
- Both current markets are deployed, activated and selected in the frontend.
  The last complete local contract, backend and browser checks below passed.
  These results do not establish continuous public MARK or actual public 5× fills.
- The public campaigns stopped before completing the BASIS900 window. Both
  markets entered another bootstrap epoch at 05:00 UTC. A generated test owner's
  order after rollover produced `NoFill` when stale maker liquidity was pruned;
  the test correctly rejected it as a successful fill. Positions were flat at
  the service pause. Both final publisher deliveries were subsequently verified
  canonically finalized, with their original journals retained.
- The latest requested frontend follow-up remains unfinished: clarify historical
  chart observations versus fresh executable INDEX, restore continuous MARK,
  and verify public leveraged orders. Paused feeds expire, so historical chart
  values can remain visible while current INDEX/MARK and leverage are unavailable.
- A proposed sampler cadence retry change was not implemented. A private launcher
  experiment alone is not validated for restart. GitHub CI has not run this
  snapshot because it has not been pushed. Public hosting remains deferred.

## Earlier checkpoint (04:55 UTC / 10:25 IST on 7 October)

- The independent Astra lead and its contract/service fix agents completed the
  source audit. Sixteen confirmed findings are repaired, with targeted regression
  evidence and an additional hardened source-qualification helper. The audit is
  scoped evidence, not a guarantee that no undiscovered defects exist.
- Final full risk-contract CI: **849 passed, 0 failed**. Oracle contract CI:
  **342 passed, 0 failed**. Monad integration: **82 passed, 0 failed**.
  Frontend: **58 unit and 28 integration tests passed**, typecheck and production
  build passed. Runtime TypeScript passed. Test totals overlap.
- The fresh local leveraged backend proof passed through real sampler readiness,
  INDEX/MARK availability, directional 5× caps, leveraged trading, bounded
  settlement preparation, reserve-funded deficit absorption and full owner
  claims. Canonical receipts and unchanged source fingerprints passed. This uses
  controlled Anvil time, synthetic local prices and mock resolution; it is not
  public-chain or authentic-source settlement evidence.
- The final browser lifecycle **passed** against a separate verified local
  deployment, including funding/rejection recovery, owner/network guards,
  orders, fills, close, withdrawal and settlement claim. Chrome layout checks
  also passed light/dark at
  320/768/1024/1440 pixels, with range controls, keyboard crosshair and order-book
  price selection; no page errors or horizontal overflow were observed.
- Both current V1 markets (deployment attempt v4: independent Nebraska Senate
  outcome and Republican House outcome) are deployed, activated and selected in
  the rebuilt frontend. Their engines and vaults were discovered automatically
  by the matching local indexer. `addresses.md` contains only current contracts.
  Chrome loaded both market rows with no page errors or horizontal overflow.
- The oracle assertion ledger is funded with 22,000 test tokens; its lifetime
  per-market allowance is 3,336. All treasury receipts are verified. The failed
  zero-step listing rehearsal remains archived; it sent no deployment transaction.
- Both public publisher, keeper and maker campaigns are running with separate
  funded actors. Two independent test traders each received 2 MON. Real-source
  price windows and public trading proofs are now in progress. The matching
  final browser lifecycle passed funding, orders, fills, close, withdrawal and
  settlement claims, with final source fingerprints unchanged.
- Both exhausted v3 campaigns were gracefully drained and their pending journals
  and nonces reconciled. No pending transaction remained. Journals are intact;
  current prices expire while publishers/keepers are stopped.
- The user supplied **40 test MON**; the initial verified deployment-wallet balance was
  **40.374 MON**. The factory and a representative market passed fork rehearsal.
  Their gas limits for one factory/two markets, repriced at observed 102 gwei,
  reserve about **9.89 MON**. Planned initial service funding is **18 MON** and
  two generated test traders **4 MON**, leaving roughly **8.49 MON**. Actual
  public gas prices and runtime costs remain authoritative. Actual confirmed
  factory-plan cost is **3.543841896 MON**. No further top-up is requested.
- Follow-up publisher latency repairs passed **474/474** isolated Linux tests
  and independent Astra review. Workspace JavaScript was rebuilt and frozen.
  A new matching backend proof passed all lifecycle, receipt and source-integrity
  gates. The previous complete proof remains historical evidence. Runtime
  engine bytecode still matches the rehearsed hash.
- Real-source probes rejected political/football/monthly-crypto candidates for
  freshness gaps, and daily Bitcoin candidates for excessive impact spread.
  The independent Nebraska Senate outcome (Polymarket 634893) passed a fresh
  15-minute assessment: 893 valid polls, 7 rejected future-time polls and no
  failed observations. Original 30-second lifetime, five-second headroom and
  1,000-share depth remain unchanged. Maximum observed carry was 24.998s;
  this does not prove the additional signing/inclusion delay will fit. The
  Republican Nebraska outcome failed the headroom guard. The Republican House
  outcome (562803) also passed its full 15-minute probe and is selected alongside
  the independent Nebraska outcome. Exact identities and qualification hashes
  are pinned in the deployment selection. A passing interval cannot guarantee
  future vendor availability or chain inclusion.
- Earlier runs whose final source/artifact integrity checks failed remain failed
  evidence. The new backend and browser proofs passed their integrity gates; no old
  report was relabeled. A host suspension from roughly 23:41 to 03:31 UTC
  interrupted a browser run and two source probes; those remain failed, and
  fresh runs were started after wake.
- The new independent pricefeed CI job covers its package, shared engine ABI
  and JavaScript runtime helpers. Its corrected clean Linux replica passed
  **466 package and 33 helper tests**. The oracle job now also covers the keeper
  wrapper and its **7 passing gas-policy tests**. Python is explicitly installed
  for archive verification. GitHub itself has not run these unpushed changes.
- No commit or push has been made. Continuous public MARK and actual public 5×
  fills remain unproven. Public hosting remains deferred.

Evidence: `artifacts/integration/frontend-protocol-validation-20261007/`,
[the independent audit](PROTOCOL_AUDIT_20261007.md),
`tmp/live-markets-v4-20261007/post-latency-contract-proof-pinned/` and
`tmp/e2e-20261007-045241/`.

## Earlier v3 validation (22:50 UTC on 6 October / 04:20 IST on 7 October)

- Both verified v3 markets and their factory/vault are selected in the production frontend.
  Their archived predecessors remain available for owner custody actions.
- The reference-video-inspired chart, range controls, keyboard crosshair, order-book price
  selection and compact ticket passed Chrome checks at 320/768/1024/1440 pixels in light
  and dark themes, without page/asset errors or horizontal overflow.
- Frontend typecheck, 49 unit tests, 26 integration tests and the production build passed.
  The complete local browser lifecycle now passes, including the final owner claim; the
  older failed claim assertion described below is historical and has been corrected.
- The full Linux pricefeed suite passed 466/466. Oracle workspace packages/services passed
  726/726; oracle contract CI passed 342/342 and the Monad integration gate passed 82/82.
  CRE resolution (15 tests) and dry-run (10 tests), their typechecks and WASM builds passed.
- Both real v3 independent test owners completed funding, filled trading, close, release
  and withdrawal with canonical receipts. These are not the user's Privy wallet.
- The separate Astra audit fixed nine confirmed findings and added regression coverage;
  see [PROTOCOL_AUDIT_20261007.md](PROTOCOL_AUDIT_20261007.md). Follow-up validation continues.
- Public INDEX300 is currently available on both markets. Genuine source timing and
  publication/sampler latency caused pending book captures to fail provenance checks.
  The bounded scheduling fix is running; MARK/BASIS continuity and real 5× fills remain
  unverified. A 5× deployment cap alone is not proof of currently available leverage.
- The complete local leveraged settlement proof is still running. Additional test MON
  was requested for sustained public publishers, samplers and leveraged test owners.
- No commit/push has been made at this checkpoint. Public hosting remains deferred;
  services currently run as bounded local test campaigns with durable private journals.

Evidence: ignored `tmp/live-markets-v3-20261007/`, the current local run
`tmp/e2e-20261006-222722/`, and committed sanitized audit/deployment artifacts.

## Historical checkpoints — 6 October 2026

The entries below preserve earlier outcomes and remaining work as recorded at the time;
the current checkpoint above supersedes their status.

No commits or pushes have been made. This report distinguishes verified transactions
from service startup and from work still awaiting evidence.

## Completed checks

- Frontend typecheck, 39 unit checks and 18 integration checks passed in the E2E runner.
- An isolated production frontend build connects to a verified local factory deployment.
- Browser wallet funding, rejection handling and the owner-change interruption check passed.
  The owner change stopped funding after approval, before deposit/allocation.
- The current browser run passed post-only placement, individual cancellation, cancel-all,
  wrong-network blocking, IOC fills, reduce-only close, a match between two independent
  browser owners, and collateral release/withdrawal. Assertions check receipts, positions
  and balances. The run then failed on a settlement assertion: after a confirmed
  claim, the test expected vault free balance to increase. The contract pays the
  entitlement directly to the owner's wallet. Correcting that assertion and
  rerunning the complete lifecycle remains outstanding.
- Real Privy login and embedded wallet creation passed in visible Chrome. The actual wallet
  received 0.2 test MON. Real faucet and allocation of five test tokens finalized successfully.
  Public-wallet release/withdrawal remains unverified: the UI currently reports zero
  releasable collateral while mark pricing is unavailable; no release was submitted.
- Public pricefeed journals resumed, with checksum-bound budget transitions rather than resets.
  Genuine Polymarket observations have finalized on the fresh Monad testnet engine.
- The local market-ops process finalized sampling and epoch rollover transactions.
- A dedicated local Envio instance caught up with the fresh deployment. Its unauthenticated
  read-only GraphQL endpoint at `http://127.0.0.1:8082/v1/graphql` returns the correct market
  and real trading events. It uses a separate database, leaving older indexers intact.
- The real keeper planners successfully read the enrolled market. A transient unreadable
  result also occurred and later polls recovered. Public writes are disabled in this
  observer; no settlement job is due for the ongoing event.
- The CRE listener advances its finalized-block cursor with an empty queue in read-only mode.
  The separate real CRE CLI FeedSpec simulation returned NOT_READY for the ongoing event.

## Fixes found during testing

- Optional ERC-20 `symbol()` metadata no longer prevents wallet balance/funding reads when
  the token and vault identities and six-decimal units have been verified.
- Price and size labels now explicitly identify their inputs for assistive technology.
- A transaction-completion race is fixed: the wallet signing lock is released before the
  UI announces completion. Query refreshes no longer retain that lock and block the next
  action. The current browser run passed the previously failing consecutive-order/cancel flow.
- macOS zombie processes no longer make the local-stack cleanup falsely report live services.
- Local build aliases and cache isolation now select the intended fixture manifest reliably.
- The login checker rejects a headless CDP connection and opens visible Chrome by default.
- Test selectors now distinguish side controls from Submit and transaction feedback from
  concurrent loading messages. Test prices respect the contract's actual bootstrap band.

## Leverage status

The selected public listing has a **5× deployment ceiling**, a staged/activated synthetic
calibration profile, and frontend choices for integral targets 1× through 5×. The live
`leverageCaps()` still returns 1× when the index/mark windows are unavailable. Those are
contract admission checks, not an additional frontend hardcode.

The campaign tests authentic INDEX300, independent book PERP60 and BASIS900 coverage,
maker quotes, and epoch activation. Public 5× availability/fills are **not yet certified**.
The initial public RPC rate limit and publication intervals above 30 seconds were observed
failures, retained in the service logs; accepting some price packets alone is insufficient.

## In progress / remaining

1. Finish the fresh browser lifecycle's settlement claim and final withdrawal assertions.
2. Repeat the complete leveraged local contract proof after the macOS cleanup fix.
3. Complete owner-confirmed real Privy release/withdrawal, then trading when admitted.
4. Prove continuous public price/book coverage and actual higher-leverage admission.
5. Connect the local matching indexer to a rebuilt public frontend and verify history in-browser.
6. Exercise service restart/reconciliation without clearing journals; retain exact receipts.
7. External wallet confirmation remains a separate human checkpoint. Public real-event
   settlement waits for an eligible event; local scripted settlement is labelled separately.

## Evidence

- Latest local run: `tmp/e2e-latest.json` → stage logs and Playwright traces.
- Service campaign: `tmp/e2e-services-20261006/` (private, ignored).
- Real Privy authentication: `tmp/e2e-live-2026-10-06T02-31-46-439Z/report.json`.
- Commands, scope and public gates: [E2E_TESTING.md](E2E_TESTING.md).

Hosting is deferred until the local tests are complete. These test services are bounded
campaigns on this laptop; they are not an unattended production deployment.

## Sponsored RPC check

The supplied Spectrum endpoint was checked without changing active RPC configuration.
The real publisher preflight passed, and a 60-second 5 requests/second run passed
300/300 calls. At 10 requests/second, one of 150 receipt/read requests timed out;
large code responses were also slow or timed out. No rate-limit response was seen.
See [SPECTRUM_RPC_TEST.md](SPECTRUM_RPC_TEST.md) for exact measurements and limits.

### Price recovery update — 6 October, 16:07 UTC

- The frontend now uses a server-side read RPC proxy, keeping the sponsored endpoint
  out of browser configuration. Runtime hashes are verified with compact, block-pinned
  `EXTCODEHASH` calls. Read failures no longer start an overlapping account request on
  every new block. Chrome verified the connected owner's 995 wallet tokens and five
  allocated tokens. Frontend typecheck, 42 unit checks, 18 integration checks and the
  production build passed.
- Both expired publisher nonce reservations were reconciled without resetting journals.
  The second cancellation finalized as
  `0xeb6a22dba1e039c194b1f4c884820e6e2a34c872e7f9397d0e5d998adf7b74ac`.
  The latest recovery/preflight test run passed 50 checks. Read fallbacks use individual
  requests because the public Monad endpoints rejected JSON-RPC batch arrays.
- The bounded publisher restarted at 16:07 UTC, alongside local market maintenance and
  funded fixture makers. Restart alone does not establish healthy pricing: the continuous
  INDEX300/PERP60/BASIS900 windows and a completed epoch activation still need live proof.
- At this checkpoint both index and mark remained unavailable. The next hourly activation
  is 17:00 UTC (22:30 IST), conditional on complete windows at that time. No freshness or
  risk guard was relaxed to display a price.

### Live-source checkpoint — 16:30 UTC

The laptop resolver returned an unreachable address for the Polymarket book host.
A process-only resolver corrected that route while preserving HTTPS verification and
the exact market/token binding. Authentic observations resumed and the browser showed
an index of **0.225** after INDEX300 became fully covered at 16:20 UTC. Evidence:
`tmp/e2e-services-20261006/frontend-live-index.png` and `price-continuity.jsonl`.

This is **not yet continuous-price proof**: a later expired observation broke index
coverage again. The local publisher now requires a vendor snapshot no more than five
whole seconds old before allocation; its original timestamp and all inclusion checks
remain intact. Preflight/publication/lifecycle tests passed 67 checks after parallelizing
independent pinned reads. A maker rejection was preserved and decoded; the buy quote
then finalized. Sell-side liquidity, complete book windows and normal mark activation
remain in progress.

### Confirmed upstream limitation — 16:34 UTC

The preserved source journal shows a **42.584-second gap between vendor book
timestamps** while adjacent successful captures were only **1.037 seconds apart**
(next capture at 16:31:44.088 UTC). This exceeds the engine's 30-second carry limit
independently of publication latency. GET `/book` and POST `/books` return the same
vendor book timestamp for the exact linked token; a cache-busting query does not
produce a newer timestamp. No local clock was substituted.

Evidence with capture IDs and journal hashes is retained in
`tmp/e2e-services-20261006/source-liveness-gap.json`. The frontend index was observed
at 0.225, but uninterrupted index availability and normal mark pricing remain
unproven. The user has been asked whether to retain this source with clearly labelled
outages or select a more actively updated real event while preserving the pricing
rules. No new market was deployed and no contract freshness limit was changed.

## Market replacement — 6 October 2026, 17:05 UTC

The user requested retiring the stale Iran blockade event and selecting a more active replacement. The frontend now archives the old event while retaining Portfolio and collateral access. Its publisher, market-ops and maker processes are stopped with journals preserved. The JD Vance 2028 election market is selected, not deployed. See [MARKET_REPLACEMENT.md](MARKET_REPLACEMENT.md) for source observations, the interrupted qualification boundary, current 5× listing versus 1× live caps, and the deployment preparer’s 29-day horizon restriction. Typecheck, 42 unit checks, 18 integration checks, production build and targeted Chrome archive checks passed. No new market transaction, commit or push was sent.

## Football CRE result tests — 6 October 2026

The long-dated election was subsequently rejected by the registry's contract-level
horizon. The user selected a shorter event and then approved testing direct
football results through CRE, with Polymarket retained for probability pricing.

The supplied API-Football key works and stays in the ignored workflow environment.
Three live CLI simulations compiled and fetched authentic completed fixtures:
France win → YES, Belgium win → NO, Northern Ireland win after a draw → NO.
All three agreed with their exact finalized Polymarket markets. The shared
football adapter pins fixture/team/competition/season/kickoff identity and refuses
unfinished, contradictory and unsupported results. FeedSpec (117), resolution
workflow (14) and dry-run workflow (10) checks passed. Typechecks passed after
fixing the existing fork verifier's widened Bun pipe type.

This proves live authenticated evaluation and mocked report binding. It does not
prove a new deployed football market's settlement, continuous price windows or
5× admission. The current one-hour L1 window also needs governance configuration
for football, and the risk engine requires full backing 12.5 hours before T.
See [FOOTBALL_CRE_TEST.md](FOOTBALL_CRE_TEST.md) and its evidence links. No public
transaction, commit or push was sent by this test campaign.

## API-Sports catalog — 6 October 2026

Registered the nine additional requested hosts alongside football. All ten
authenticated `/status` checks passed with the same server-side secret and
reported active Free subscriptions with 100 requests/day. Added a repeatable
bounded access probe, shared provider catalog and generated CRE/watchdog auth
configurations. E2E typecheck passed. This establishes access, not new sport
resolution adapters or on-chain market listings. See [API_SPORTS.md](API_SPORTS.md).

## Shared rules and new live-market campaign — 6 October 2026

Implemented `sports-v1`: immutable identity/scope bindings, common winner/draw/
total/top-N predicates, provider normalization and a shared CRE/watchdog evaluator.
F1 requires a completed race plus an independently fetched matching classification.
Historical authenticated results validated nine sports (football plus eight new
adapters); Rugby returned no accessible fixtures. New real CRE CLI simulations for
NBA and F1 passed. FeedSpec: 150 tests passed. Workflow/watchdog unit checks: 64
passed. Relevant package typechecks passed. An accidentally included existing fork
suite failed its setup; it is not counted as a successful lifecycle check.

See [SPORTS_RULES.md](SPORTS_RULES.md) and
`artifacts/integration/sports-rules-20261006/report.json` for coverage limits.
Current-season F1 and some future-date queries are unavailable on the Free plan.

The first replacement market deployment is in progress: 2026 Republican Senate /
Republican House, immutable ceiling 5×. Listing transaction:
`0xc1735847dd2464b07853be09736b38deb5cce23e6fd8b01f67741aaf8211aaaa`.
Full local deployment rehearsal passed before broadcast. The activation timelock,
publisher, independently funded book and live window checks remain separate gates.
The second selected market is Democratic Senate control in the same election.
These listings explicitly settle against finalized binary Polymarket payouts;
they do not use the sports API for political outcomes.

Source screening now supports exact team-named binary outcomes and bounded 2 MB
event responses. Preserved 597-capture runs for both political sources passed a
re-evaluation against the existing 30-second lifetime and five-second inclusion
headroom. Neither contract freshness nor calibration requirements were relaxed.
The first source also passed a fresh 595-capture continuity review. No statement
of uninterrupted public prices or admitted 5× trading is made from these source
checks alone. Native test funds were allocated from the retired publisher under a
rehearsed six-transaction plan; its previous journals remain intact.


## Live markets and search update — 2026-10-06 18:50 UTC

Both replacement markets completed their seven-transaction deployment and activation.
Their verified manifests are selected together in the frontend; the Iran market is
archived and remains accessible for existing balances. Each new market has a funded
100,000-token reserve, a 5× immutable deployment ceiling, and independent maker owners
funded with 2,000 test collateral tokens each. These are synthetic risk calibrations.

Market search filters titles, short names, categories and sources. The URL retains the
query through wallet-provider loading and supports sharing. Chrome checks passed for
filtering, clear/Escape, no results, exact terminal navigation, and both light/dark themes
at 320, 768, 1024 and 1440 px. No browser runtime errors occurred. A read-only RPC origin
check incorrectly compared localhost to Next's internal 0.0.0.0 bind address; the fix
uses the requested host, preserves cross-origin rejection, and has a regression test.
Frontend build, 18 integration tests and 43 unit tests passed.

Public source fetching and canonical publication are evidenced on both engines, but
publication gaps have interrupted the required 300-second index coverage. The Senate
market briefly had an available 0.645 index and two funded resting orders. The mark
and public 5× fill remain unverified; current dynamic caps are still bootstrap 1×.
Sampler timeout handling and missed MINED-to-finalized capture coordination were
corrected without changing timestamps, the 30-second lifetime, or transaction journals.
Search success is not evidence of reliable live price availability.


At 19:01 UTC the rebuilt Chrome page displayed the Senate market's verified INDEX
at 0.645, with no browser runtime errors. Evidence: `browser-live-index.json` and
`markets-live-index.png` in `tmp/live-markets-20261006/`. Its epoch-2 independent
maker quotes also finalized. Availability has not yet remained continuous through
book sampling, so this is an observed successful read, not an endurance pass.
Raw source archives identify genuine >30-second Republican-control snapshot gaps;
cache-bypass GET probes returned the same vendor timestamps. Changing a local
clock or displaying that quote as a valid TWAP would be incorrect.


## Publisher recovery and independent owner — 2026-10-06 19:18 UTC

Both publishers stopped after a timed-out lifecycle read. The underlying RPC read
was still running, and shutdown incorrectly attempted to release its journal lease,
masking the retryable timeout with `LIFECYCLE_CHECK_RUNNING`. The pipeline now drains
that read before releasing resources and preserves the original error. All 68 targeted
preflight/publication/lifecycle/relay tests passed, including a regression proving
restart with the original journals and no publication after the timeout. Both services
resumed authentic on-chain observations; continuous index/mark availability is still
under observation. No timestamp, coverage or on-chain risk guard was weakened.

The requested test-MON top-up was confirmed. A rehearsed eight-transaction plan
allocated 32 MON across the two publisher, keeper and maker pairs; canonical public
verification passed. This allocation is testnet gas, not market collateral.

Independent test owner `0x332328512c55d434F934dE6D1F4f93C07D2EFfFD` completed
20-test-token mint, approval, deposit and allocation of 10 tokens on the Senate
market. Finalized canonical receipts and exact wallet/free/allocated balances passed.
The owner's remaining wallet balance is 10 test tokens. This proves custody setup;
buy, close, release, withdrawal and live leveraged fills are not yet claimed.
No user Privy wallet was impersonated. Evidence is retained under
`tmp/live-markets-20261006/democratic-senate/trader/`.

At 19:21 UTC both engines exposed available indexes (Senate 0.645; Republican
control 0.085). Chrome checks passed for the markets page and Senate terminal;
the latter showed INDEX 0.645 and bid/ask 0.635/0.655 at 19:25 UTC with no runtime
errors. This remains intermittent availability, not a continuous feed certificate.
The Senate's 60-second book TWAP also became available. Its 900-second basis
window and live higher leverage remain unverified.

The first public third-owner buy finalized but emitted OrderRejected(11), with
no fill, during an index freshness gap. Transaction:
`0x14c3d2b1d48ee8225a8101ba4ae9aeebf1a45c92cc60f9aa2b1d203e3e8c34fd`.
This is retained as a failed trading attempt. The proof explicitly rejects
successful receipts without the exact fill and position change. Fork rehearsals
now advance one second per block to replay the captured state despite slow remote
storage reads, and each replay has a separate evidence directory. Failed attempts
are retained. Public retries use a new nonce and require a freshly observed index.

Pending keeper receipt reads now overlap independent identity reads, while both
must succeed before journal mutation or rebroadcast. All 49 service tests and its
typecheck passed, including identity-failure/pending-journal regression coverage.
Keepers resumed with existing journals at 19:35 UTC.

At 19:38 UTC the independent owner's second buy attempt filled exactly 10 claims
at 0.655 on Monad testnet. Canonical receipt, engine-emitted Fill and the owner's
10,000-lot position were verified. Transaction:
`0x1f24cb6b61e3107b9e3c1b0071aad763a6fd7c4b97f57df4fa94dfcfea4f9101`.
This was fully backed bootstrap trading, not a leveraged fill. The new public
attempt retained the first rejection's plan, receipt and journal.


## Immutable capacity mismatch found — 2026-10-06 19:45 UTC

The independent owner's public flow completed: buy 10 claims at 0.655, close at
0.635, release 1 test token and withdraw it. Exact Fill events, zero final position,
8.8 test tokens remaining as allocated cash, zero free balance, and 11 test tokens
in the wallet were verified against canonical finalized blocks. The earlier
no-fill rejection remains retained as failed evidence.

The live test exposed a deployment error: both replacement listings set
`oiCapLots = depthNLots = 1,000,000`. The registry engine's depth guard requires
`oiCapLots - oiAllLots >= depthNLots`; any nonzero OI therefore disables book
sampling. Best bid/ask and trading can continue, but the mark cannot mature. This
is not a frontend display issue. Existing per-market caps are immutable.

The deployment helper now uses ten times the required sampling depth as its demo
OI cap, verifies the deployed cap, and supports an explicit deployment revision
for replacement identities. Two integration tests reproduce the old setting and
prove the corrected 1,000,000-depth / 10,000,000-cap setting retains depth and
confirms a new sample after a bootstrap fill. Both passed. A capacity-policy unit
test and e2e TypeScript checks also passed. No contract freshness rule changed.

A new campaign is prepared under `tmp/live-markets-v2-20261006`, with old journals
retained. 5,000 additional test collateral tokens were minted and deposited in the
assertion ledger under a rehearsed three-transaction plan to support the larger
listing bonds. The first corrected market's seven-step rehearsal passed and its
public deployment is in progress. Frontend cutover waits for verified deployment
and preserves old owners' portfolio access.


At 19:57 UTC the corrected Senate deployment passed all seven canonical public
transactions, including timelock execution. New engine:
`0xE97032806ffe4009A70Af7e31a17D07459630c74`. The old publisher and keeper were
drained, their journals retained, and the reused publisher nonce checked before
the new service started. Fresh source observations are reaching the new engine.
The independent maker funding sequences are in progress. Republican v2 is prepared;
its public deployment has not started yet. The frontend still selects v1.

The Senate v2 maker owners each completed independently signed mint, approve,
deposit and allocation with canonical receipt and exact-balance verification. Its
publisher has accepted more than twenty authentic observations; initial index
coverage is warming. The keeper completed the 20:00 UTC accounting rollover.
Normal pricing is still gated by complete index/perp/basis windows at an epoch
opening; 5x is a configured ceiling, not current admission. Republican v2 passed
its complete fork rehearsal and public steps 1–6; timelock execution is pending.


## Replacement markets live — 2026-10-06 20:10 UTC

Both capacity-v2 engines passed seven canonical public deployment transactions:

- Democratic Senate: `0xE97032806ffe4009A70Af7e31a17D07459630c74`
- Republican control: `0xa832bF72adFcCCCcD52Ef055FB4c314eCb773bD8`

Each has its own resumed role accounts, fresh domain-specific journals and
independently funded maker allocations. Old service journals were drained and
retained. Frontend selection passed code-hash, canonical anchor, listing, factory,
vault and registry checks; three old engines remain archived for portfolio access.
The frontend production build and 18 integration checks passed. Chrome search,
clear/reset, source/category filtering, terminal navigation and light/dark layout
checks passed at 320, 768, 1024 and 1440 pixels without runtime errors.

At 20:09 UTC Chrome displayed Senate INDEX 0.645 in both the exact market-list
INDEX field and terminal INDEX field. Envio dynamically discovered its new engine
and indexed ObservationAccepted and valid PerpObservationRecorded events. The
60-second perp window is valid; basis coverage is still warming. Republican INDEX
is still accumulating its first full 300 seconds of coverage.

A new independent owner bought exactly 10 claims on the corrected Senate engine:
`0x577c6ff0dc1061d48cd08a6b5ad8b9263b3f19ce67dee464251b1029e23dc0dc`.
Canonical receipt, Fill and position checks passed. Critically, both sides still
provided the full 1,000,000-lot sampling depth after this real fill. Evidence:
`tmp/live-markets-v2-20261006/democratic-senate/trader/post-fill-depth.json`.
Close/release/withdraw verification is in progress. Dynamic leverage remains 1x
during bootstrap; public mark and 5x trading are not yet certified.

At 20:10:54 UTC Chrome verified Republican INDEX 0.085 in its market row and
terminal; both price-field checks passed without page or asset errors. The Senate
owner also closed the full position. The release check correctly stopped before
signing when the index became unavailable. The publisher gas wallet had fallen
below its 0.12 MON reservation floor while the deployer retained 16.598 MON. A
rehearsed two-transfer plan moved 6 MON to each publisher. Both canonical receipts
passed; no further user funding was requested. The Senate publisher resumed its
original journals at 20:16 UTC, expired the old unsent packet, and finalized a new
fresh observation. Its five-minute index window must recover after that outage.

The campaign wrapper now waits for publisher funding and resumes the same journals
instead of exiting on this known gas-floor condition. The owner proof also checks
fresh index and positive `usableReleaseAtoms` before attempting a release. Its
typecheck passed. No release transaction was sent during the unavailable window.
The close/release journal and failed estimate remain retained. An independent
read-only observer is running through 21:25 UTC to record any canonical normal mark
and directional 5x caps; this will not be presented as a leveraged-fill proof.

At 20:21 UTC both indexes recovered. Chrome rechecked the exact INDEX fields in
both market rows and terminals: Senate 0.645, Republican control 0.085, with no
page or asset errors. The independent owner's release and withdrawal then passed;
final position is zero, allocated cash 8.8 test tokens, free balance zero and wallet
balance 11 test tokens. Withdrawal:
`0x9a8df76d83169fbe44df0bf56aa61de93583e305b0bfd576ac96a5921a97f2cd`.

Canonical sample receipt
`0xb4b65a4b41e58ccefd0dd144f3f8ae444f32ef1ea81e0279821bcf5f26176724`
proves a valid perp/basis observation after the real fill. The capacity fix therefore
has contract regression, live depth and live post-fill sample evidence.

The consolidated credential-free proof is
`artifacts/integration/live-markets-20261006/report.json`. Both deployment ceilings
are 5x, but live admission remains 1x during bootstrap. Normal marks and a real
leveraged fill remain unverified. The next hourly opening is 21:00 UTC / 02:30 IST;
readiness still depends on all windows being valid then. Local publishers, keepers,
makers and the read-only observer remain running within their bounded campaign
windows. Current local status is in `tmp/live-markets-v2-20261006/health.jsonl`;
normal mark/cap results will be written to `normal-pricing-observation.json` there.
The campaign is not permanent hosting, and no public-readiness claim is made.

### 2026-10-07 IST — funded recovery, 5x ticket sizing and live mark checks

The follow-up investigation found a canonical normal-pricing snapshot for the
Senate v2 market at 21:00:15 UTC on October 6: INDEX and MARK were both 0.645,
with directional caps `[5, 5]`. The immutable 5x deployment cap is active.
The subsequent outage was operational: sampler gas floors stopped both keepers,
and the publisher's mandatory sample-ack wait then stopped otherwise independent
INDEX publication. Republican control missed its normal-pricing epoch transition.

The user's refill was verified on chain. A rehearsed, canonical eight-transfer
plan allocated 52 test MON to the two publishers, keepers and maker pairs. A
second rehearsed plan allocated 4 MON for publisher continuation and 1 MON to the
independent test owner. All original signed journals and failed attempts remain.
Keepers now wait for funding instead of exiting; publishers continue independent
INDEX delivery if a sampler heartbeat stops or its acknowledgement times out.
Only an exact engine/sequence acknowledgement updates the sampling timestamp
barrier. Contract capture/checkpoint checks still reject conflicting book samples.
The coordination regression suite passed all three checks.

The existing audited budget-renewal mechanism was used, with historical gas
reservations retained. It exposed a large-archive bug: JSON serialization of the
~672 MB source journal exceeded V8's string limit. `budgetJournalSnapshot` now
hashes rows incrementally while preserving the exact prior canonical hash format.
The pricefeed build and 37 publication tests, including hash compatibility and
budget integrity/replay tests, passed. Both renewal transitions completed.

The frontend's old 5x shortcut sized by entry cost alone and could violate the
post-fill initial-margin bound after crossing the spread. The replacement sizes
from the live mark and adverse fill loss, rounds down in integer lots and keeps
exact contract admission mandatory. Existing resting orders disable flat-account
leverage sizing rather than silently reusing their reserved collateral. All 45
frontend unit tests, 18 integration checks, typecheck and the production webpack
build passed. The production server was stopped before rebuilding and restarted
on port 3100, avoiding mixed build assets.

Live re-verification is in progress: canonical INDEX/PERP/BASIS recovery, both
rendered price fields and current 5x limits, read-only browser checks of the actual
ticket at each integer leverage, and separately signed 5x long/short open-and-close
flows from the independent test owner. These are not yet recorded as completed.
The public frontend continues to use Privy; the read-only ticket harness is not
an authentication or wallet-approval proof.

## October 7 — terminal upgrade and mark continuity repair (in progress)

- Viewed the user's desktop recording. Replaced the shared probability-axis diagram with a time-series INDEX feed chart, range controls, pointer/keyboard inspection, current-mark reference, live/delayed states, and a separate clickable order book. The chart uses recorded source observations; it does not invent historical mark prices or interpolate across invalid/stale observations.
- Production browser check: light/dark at 320/768/1024/1440 px, no horizontal overflow, page errors, or missing Next assets. Range controls, keyboard navigation and book-to-ticket price selection passed. Evidence is retained under the ignored `tmp/live-markets-v3-20261007` run.
- Found a contract-level continuity problem: rejection of an unsealed capture after a fill/epoch change appended an invalid historical sample, unnecessarily breaking the 900-second basis window. The repair discards that unsealed mutation while retaining the original accepted observation's 30-second expiry. Expired samples, revised INDEX checkpoints, unavailable INDEX and confirmed thin-book observations still invalidate pricing.
- Contract validation: 105 engine integration tests and 14 leveraged factory tests passed, including new post-fill, rollover/requote and repeated-mutation expiry regressions. Full contract CI profile is running separately.
- New immutable engine code requires a replacement factory and market deployments. The replacement was rehearsed before broadcast and uses the existing governance timelock, registry, oracle and token; it creates a new shared vault. Twelve test MON were returned from the stopped generated keeper wallets to the original deployment owner for this work. Old market custody must remain bound to its original manifest/vault.
- Frontend unit tests: 47 passed. Frontend server/integration tests: 18 passed before the manifest switch. Final build/browser/live-order validation will be repeated against the verified replacement deployment.
- The new markets still require fresh INDEX/book/BASIS windows and a completed hourly opening before normal pricing and up-to-5x admission. A deployment cap of five does not bypass these conditions.
- User requested an independent Astra-led multi-agent protocol audit after this implementation, with delegated fixes and verification before the final push. Audit and final public 5x round trips are still pending; this entry does not certify them.

### Verified v3 deployment and initial browser checks

- Both v3 markets completed their seven public activation steps. The replacement factory/vault and market identities are recorded in DEPLOYMENT_PROGRESS.md; the frontend primary manifest now selects them. Prior deployments remain in `archived-deployments.json`, with SDK custody actions bound to each market's own vault.
- Full contract CI finished: **837 passed, 0 failed, 0 skipped**, including the CI fuzz/invariant profile and gas snapshot gate (612 seconds). This is source/test evidence, separate from live market readiness.
- Production v3 build passed. **20 frontend integration checks** passed, including archived vault custody and archived delegated-order restrictions. Chrome repeated light/dark checks at 320/768/1024/1440 px: no page/asset errors or horizontal overflow; range controls, keyboard inspection and book price selection passed.
- Both markets have running publishers, independent funded makers and serialized keeper/sampler processes. Senate's real INDEX and PERP windows are available; normal pricing still requires the 23:00 UTC opening and complete basis coverage. The test owner has completed funding and an exact public opening fill. Remaining close/withdraw and 5× checks are in progress.
- The requested independent Astra lead is auditing with delegated reviewers. Confirmed watchdog pagination and RPC request-body timeout issues are being fixed with regressions. No final audit certification or zero-bug guarantee is claimed.
