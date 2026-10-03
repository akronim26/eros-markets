---
title: "Risk & Clearing"
subtitle: "Agent-ready implementation contract for the two-developer middle layer"
author: "Eros Markets / EventPerp — Paper 1"
date: "Specification v1.1 · 30 September 2026"
lang: en-US
abstract: |
  A standalone coding specification for the team responsible for accounting, margin, reserve coverage, funding, premiums, liquidation and settlement between the order book and three-layer resolution oracle. It selects one consistent implementation baseline, defines exact units and transaction order, records deliberate source amendments, and provides typed integration contracts, worked arithmetic and 88 owner-assigned tasks across eight parallel work blocks, with eight explicit integration stops. The math engine is built and verified first. Cash settlement is the first release. Leverage and funding must be implemented and tested behind explicit release gates. This document is a design and handoff artifact; it is not deployed code or a security-audit certificate.
---

# Read this first: the contract for your two-person team

**Deliverable:** implement the Risk & Clearing layer for Eros Markets / EventPerp, Paper 1 only. It is the accounting and risk authority inside each isolated market engine. The order-book team supplies matching; the oracle team supplies an authenticated halt and final outcome. This document tells the middle-layer team what to build, how to join both sides, and what evidence makes each piece complete.

**Status:** implementation specification v1.1, 30 September 2026; economic baseline v1.0. This is a selected engineering baseline, not deployed code, an external security audit, or a claim that the source parameters have been calibrated. Mathematical identities below have stated assumptions. The companion machine-readable tasks and arithmetic fixtures are part of the handoff. Execution plan v1.1 replaces the previous R-task schedule; follow the math-first plan in section 10 and the A/B backlog in section 13. The original source PDFs remain the evidence for historical designs.

**Reading order for an AI agent:** read sections 1–5 and the math-first plan in section 10 before modifying code; then the accounting, order-book and oracle contracts; start your A/B lane at W0 and respect each G gate. Never infer units from variable names, choose an old alternative from the master document, or treat the task acceptance text as an already-passed test.

## What you own

| Section / team | Owns | Hands to the next section |
|---|---|---|
| Order book — counterpart team | Order IDs, FIFO/levels, matching, slot packing, cancellation traversal, signature/router authentication | Authenticated order intents, maker-price fills, bounded book-liquidity observations; invokes internal risk hooks |
| Risk & Clearing — your two developers | Isolated cash and positions, custody allocation, fees, index/mark validation, margin, reserve and premium, funding, order collateral reservations, liquidations, market clock, frozen settlement, claims and read models | Admission or rejection; atomic cash/position result; halt OI and snapshot; prepared claims |
| Three-layer resolution — counterpart team | Rules/evidence, models, Layer 1–3 routing, human review, assertion/dispute/bond machinery and final outcome | Calls only the configured engine halt/finality API; reads immutable halt exposure |

Do not implement the CLOB or the AI/UMA consensus machinery in this work package. Do implement their precise interfaces, deterministic mocks, integration fixtures and failure handling. Shared registry/factory work must be coordinated with the other three developers. There is one per-market economic ledger; SDKs and indexers may reproduce views but cannot maintain an alternative authoritative balance.

## Sources and precedence

B means **Eros Markets Leveraged Perps on Binary Outcomes — Build Spec**, 39 pages. O means **Eros Markets Oracle Full Spec (Layers 1–3)**, 25 pages. D means **eventperp-design**, 25 pages. R means **Event Perps on Monad 2 — Metropolis Project Plan(3)**, 34 pages, reference only. Only R's Paper 1 scope is implemented. R is not an additional set of protocol requirements.

Use this specification's explicitly selected decisions for this work package. B provides economic accounting; O controls the external resolution boundary; compatible D details inform engineering structure. D's six-hour floor, dual-price liquidation, separate insurance-cash bad-debt approach and unconditional midpoint INVALID are not active economic rules. Do not combine them with B by accident. Original alternatives remain in the separate master document.

## Selected amendments: do not reopen these in a coding task

| ID | Selected v1 rule | Reason / source boundary |
|---|---|---|
| DEC-01 | Internal cash uses Q = one USDC atom times $10^{18}$; custody and transfers remain six-decimal atoms | Makes lot fills exact and separates fractional accounting from token transfers; B §4 |
| DEC-02 | Hourly fixed-rate funding, bounded mandatory epoch sweep, no historic catch-up authorization | Makes lazy funding, deficit drift and budget expenditure precise; amends ambiguous B §§9,12 |
| DEC-03 | Premium integrates funding-affine deficits; excludes current-epoch premium from its own base, capitalizes at rollover; renewed account-wide 4x period on new deficit | Deterministic implementation replacing ambiguous source on-touch/cohort semantics; B §9 |
| DEC-04 | Derived floor immediately restricts admissions; bounded liquidation/takeover sweep materializes legacy backing | Time alone cannot update every account; B §10 |
| DEC-05 | Recheck each maker and every paired fill; order reservations use a conservative IM envelope | Price and account state can change after order entry; B §11 and D engineering seam |
| DEC-06 | Reserve share issuance only before market activation; live redemption disabled; residual redemption after claims are allocated and seven-day notice | Avoids inventing a manipulable live LP NAV for inherited positions; narrower than B §9 ERC-4626 liquidity |
| DEC-07 | Engine accepts finality in constant work; frozen-account and payout preparation are separate bounded jobs | Oracle Final does not imply claims ready; B §14, O §§7,9 |
| DEC-08 | INVALID retains scheduled $[T-24h,T]$ index window; early INVALID waits; new listings disclose a one-hour missing-data grace and fixed 0.5 fallback | Solves unavailable future window without changing live rules; addition to B §14 |
| DEC-09 | Conservative linear hazard upper bounds and upward-rounded risk math; absent calibration forces 1x | Avoids unbounded/underspecified transcendental evaluation; B §§6–8 |
| DEC-10 | Cash settlement is the first release; token conversion is a separate disabled extension | Preserves optional B §14 feature without two simultaneous claim paths |
| DEC-11 | Initial profile has zero trading fee; configurable fee accounting is implemented and tested | B worked-example profile. Fees cannot be enabled without including them in admission and closeout cost |
| DEC-12 | Market registry uses a bounded, never-deleting participant list, maximum 1,024 traders in v1 | Makes checkpoint and halt work bounded; throughput/account-cap increase is a measured release change |
| DEC-13 | Positive-equity accounts remain covered when bounded liquidation runs out of work; shortage alone never authorizes takeover | Prevents a caller manufacturing confiscation through a tiny work budget; narrows B §10 fallback |
| DEC-14 | Exactly backed bootstrap trading uses a valid independent index before perpetual mark windows exist | Removes empty-book startup deadlock without leveraged admission |

These are engineering decisions made for this new coding package. They are not assertions that all three PDFs originally agreed. In particular, hourly sweeps, account caps and locked reserve liquidity are deliberate MVP constraints. Keep the leveraged engine and its tests; initial deployment caps still remain 1x until the stated release evidence exists.

# Economic model, units and storage

## Exact units and signed arithmetic

| Field family | Representation | Meaning / bounds |
|---|---|---|
| `lots` / `positionLots` | uint64 order size / int128 position | 1 lot = 0.001 claim; absolute account and reserve position at most $2^{40}$ lots |
| `tick` | uint16, 1 through 999 | Price = tick / 1000; no tick 0 or 1000 trading |
| `atom` | uint256 | $10^{-6}$ USDC; deposit/withdraw integer atoms |
| `cashQ` | int256 | One atom = $10^{18}$ Q; bound absolute value below $2^{180}$ after every update |
| `pWad`, `qWad`, `iWad` | uint256, 0 through $10^{18}$ | Probability; settlement endpoints allowed; live risk requires interior supported price |
| `fundingFQ` | int256 | Cumulative Q per lot; `rateQPerLotSec` has Q / lot / second |
| `hazardWadPerDay` | uint256 | Probability-intensity parameter per 86,400 seconds; not an outcome price |
| `premiumQ`, deficits, fees, budget | uint256 | Q; never silently pass atom balances into these fields |
| Timestamps / durations | uint64 | Unix seconds UTC / seconds; no milliseconds |
| Versions / epochs / sequence | uint64 | Checked monotonic increments; revert before wrap; zero reserved where stated |

Define `Q = 10**18` and `PAYOFF_Q_PER_LOT = 1000*Q`. Signed fills have exact cash transfer `deltaLots*tick*Q`. A deposit of 120 USDC is 120,000,000 atoms and 120,000,000*Q internally. A position of 1,000 claims is 1,000,000 lots. Every public view labels its units.

For signed position $n$ in lots and cash $c$ in Q:

$$E_0=c,\qquad E_1=c+1000Qn,\qquad E(p)=c+1000np_{Wad}.$$

The last expression is already in Q, because `pWad` has the same $10^{18}$ scale as Q. **Do not divide it by WAD again.** At tick t, `pWad=t*10**15`, giving `1000*n*pWad=n*t*Q`. Full backing is exactly `E0>=0 && E1>=0`, with no price read.

Use checked signed addition and dedicated signed floor/ceil division. Widen before multiplying; use audited wide-product division primitives after dependency/version review. A signed truncation toward zero is not a rounding policy. Exposure requirements and premium debits round upward; usable assets and external payouts round downward. Paired cash transfers move the same exact Q on both sides. Funding uses one quantized rate, so debit and credit algebraically cancel including the reserve. Fractional Q residuals never become withdrawable whole atoms by rounding up.

## Authoritative state

Implement one storage layout, owned by A and reviewed by B. At minimum retain the following. Add storage only when its invariant and owner are stated.

| Object | Required fields / authority |
|---|---|
| Market configuration | marketId, token, registry, resolution authority, scheduledT, listedAt, source/rules hashes, immutable INVALID rule, template, activation caps and account bound |
| Market accounting | allocationQ, protocolFeeQ, keeperPayableQ, roundingQ, reserve cashQ/positionLots, trader deficit sums for NO/YES, funding drift cushion, remaining funding allowance, total one-sided OI including reserve |
| Funding epoch | id, start, end, rateQPerLotSec, FQ, lastAccruedAt, accrued-until cutoff, active/rolling state, frozen rollover FQ, sweep cursor, participant count fixed for sweep |
| Risk epoch | id, effectiveAt, config hash, hazard/load/risk profile, price observation version, grace anchor, monitor restriction flags |
| Account | owner/subaccount ID, positionLots, cashQ, funding checkpoint, premium segment time/base, premium paid this epoch, surchargeUntil, stored NO/YES deficit contribution, account order epoch, position version, order aggregates |
| Order reservation | market/account epoch, side, original and remaining lots, remaining valueQ, remaining fee capQ, reduce-only flag, position version; book owns order topology |
| Account registry | append-only unique trader IDs and active indexes; maximum 1,024, no deletion or ID reuse before market complete; reserve tracked separately |
| Lifecycle | effective scheduled stage, explicit early halt, full-backing sweep cursor/reconciled flag, risk epoch grace state |
| Clearing | immutable halt tuple, outcome, INVALID capture data, snapshot and payout cursors, per-account frozen values, raw claimQ, paid flag, allocated payout atoms, residual release state |

Reserve is a real ledger account that can have a signed position. It is excluded from the trader deficit sum and charged no jump premium. It is included in net positions, funding and one-sided OI. It cannot self-trade with a beneficially identical account through an internal privileged bypass.

## Custody and isolation

`CollateralVault` holds approved six-decimal USDC. A deposit credits free atoms only after verifying the actual received amount equals the requested amount; fee-on-transfer tokens are rejected. `allocate(market,atoms)` debits free balance, increments market allocation, and credits account cashQ atom-for-atom. `release(market,atoms)` touches the account and passes order-aware margin, stage and coverage tests before reversing that movement. Withdraw only from free atoms. The approved token and engine-to-vault relationship are pinned in the deployment manifest.

Across markets, recognized free balance plus market allocations plus separately escrowed claims cannot exceed actual vault custody. Unexpected direct transfers are unrecognized surplus until an explicitly authorized accounting action; never count a raw balance increase as trader collateral. There is no cross-market netting or borrowing. All external token transfers use checks-effects-interactions with reentrancy protection. Keepers, oracle callbacks and SDK callers cannot set arbitrary cash balances.

At a common economic checkpoint, market allocationQ equals trader cash plus reserve cash plus protocol fee, keeper-payable and any explicit residual ledger. Keep a signed `fundingClearingQ` contra ledger: every account funding posting p debits its cash by p and credits clearing by p. The booked identity includes this contra ledger, which is exactly zero after a complete common-index sweep. Alternatively, before lazy funding is materialized, compare **virtual cash**: stored cash minus position times unmaterialized funding. Pending premium is a matched trader debit/reserve credit; compute or defer both together. Stored Dbar excludes unposted premium: if total pending premium is P, effective reserve value increases by P and total actual deficits increase by at most P. Thus the coverage guarantee extends to pending premium without falsely claiming stored Dbar alone includes it. A sum of stale stored account cash alone is not the live conservation invariant.

# Invariants and transaction ordering

These invariants are required at every externally visible successful mutation, except the explicitly named frozen preparation accumulators which are incomplete until their cursors finish.

| ID | Assertion |
|---|---|
| INV-01 | Sum of trader and reserve positions is zero |
| INV-02 | Virtual cash plus all distinct fee/payable/residual ledgers equals market allocationQ |
| INV-03 | Recognized custody liabilities do not exceed actual approved-token custody |
| INV-04 | For y=0 and 1, reserve outcome value $R_y$ is at least maintained trader bound $\bar D_y$ plus unspent funding budget B |
| INV-05 | Each trader bound covers every still-live admitted order prefix and unmaterialized payer funding; a cached contribution has an explicit accounting index/epoch |
| INV-06 | New exposure or withdrawal passes current IM, directional cap, account deficit cap, stage and INV-04; fully backed requirements use both outcomes |
| INV-07 | Time, halted states, expired epochs and stale feeds cannot authorize catch-up risk or exposure |
| INV-08 | Only paired fills/netting/takeovers change position; oracle, SDK, deposit and direct price updates do not |
| INV-09 | No claim is enabled before immutable finality, price availability and completed allocation; each account is paid once |
| INV-10 | Same economic cutoff is used by every account in a sweep or frozen snapshot; retries do not accrue a second time |

## Why outcome coverage works

Let trader outcome values be $e_i$, reserve outcome value be $r$, and total recognized market assets after separate fees/payables be $A$. Net positions zero implies $A=r+\sum_i e_i$. Since $\max(e_i,0)=e_i+\max(-e_i,0)$, trader positive payouts total $A-r+D$. If $r\ge D$, then payouts do not exceed A. This proof applies separately to NO and YES. For an INVALID price between them, the sum of positive parts is convex, so endpoint coverage also covers every intermediate price. It assumes the maintained bounds and custody ledger are correct; it is not a proof of the entire implementation or oracle correctness.

Whole-account takeover moves both cash and position into the reserve and zeroes the trader. Without live orders, reserve slack in outcome y changes by `e_y + max(-e_y,0) = max(e_y,0)`, which is nonnegative. Moving only the position or paying a bad-debt cash amount does not satisfy this identity. This is why takeover is the terminal closeout primitive. Charge no new fee on a takeover unless a separate proof shows both outcome slacks and claim liabilities remain covered; v1 takeover fee is zero.

## One shared mutation envelope

All account-mutating entry points use this order. Book matching repeats steps 4–7 for each pair.

1. Authenticate caller/intents and nonreentrancy policy. Derive time stage and epoch state before inspecting cached permissions.
2. Advance global funding only to the earlier authorized cutoff, using the old rate and current payer positions; settle reserve funding immediately and update allowance/drift accounting.
3. Load one immutable price/risk snapshot for this transaction. It freezes market prices/parameters only; never freeze cash, OI, budgets or coverage across fills.
4. Touch every affected account to the same cutoff: settle funding, charge premium for prior segments, retire its funding cushion contribution and update its stored deficit bound.
5. Preview the action including fee destinations and reservation removal. For admission or voluntary withdrawal require all applicable checks. A liquidation follows its own exact allowed-reduction predicate.
6. Post paired cash/position/fee changes atomically, update OI, reservations and premium segment bases, and replace touched deficit contributions. One function owns these postings.
7. Recheck both outcome coverage and action postconditions against the updated mutable state. Unexpected failure reverts the whole transaction, not just one half of a fill.
8. Emit committed economic events. At epoch boundary schedule bounded reconciliation. A view/preview never creates a new funding authorization.

Rollover may be initialized by any caller, but it cannot perform an unbounded loop inside order execution. If rollover is needed, the order route returns its documented epoch-unavailable outcome; keepers use bounded jobs. Deposits/cancels that must wait for reconciliation are queued as requests or fail explicitly—never mutate half of an account under two epoch conventions.

# Pricing and the margin kernel

## Price authority and freshness

Implement `PriceObservation` with market/source IDs, sequence, observedAt, publishedAt, acceptedAt, bid/ask depth summaries, priceWad, source/rules hash and authenticated payload digest. A feed adapter verifies the configured sender or signature domain including chain ID and engine. Reject duplicates, backwards sequence/time, future timestamps, wrong market/source and unauthorized signers. Selected v1 future tolerance is zero seconds; feed collectors timestamp observations no later than chain acceptance. Accepting delayed observations does not make them fresh: freshness uses observedAt.

The risk index I comes from an independent spot/reference source, never this market's perpetual book. Use a 300-second impact-mid TWAP at an immutable calibrated depth N. An observation is usable only if both sides can price N and their spread/depth validity checks pass. Maintain a time integral; do not average sample prices by sample count. Each sample carries forward only up to its 30-second freshness limit. A window lacking complete valid coverage is unavailable. Keep 24-hour cumulative index records separately for INVALID; after an early halt only that recorder continues.

**Bootstrap:** a new empty perpetual book starts in `BOOTSTRAP`. Once the independent 300-second index is valid, allow only orders and fills that are exactly fully backed including fees, inside the index order band. This path does not call the unavailable mark/margin kernel. Funding is zero and mark-based liquidations are disabled. Accumulate perpetual depth, basis and TWAP history from these orders. Switch to `NORMAL_PRICING` only at a completed accounting epoch with all three candidate windows valid. Returning to missing/stale perpetual depth permits this same exactly-backed path only while the independent index is valid and no stronger lifecycle restriction applies. Existing leveraged accounts remain covered, may cancel/top up after any sweep, and cannot withdraw using a missing mark.

The mark is the median of (index plus 15-minute basis TWAP), 60-second perpetual impact-mid TWAP, and live perpetual impact-mid, clamped to `I +/- b(t)`. Define `b(t)=0.05*max(T-t,0)/(T-listedAt)` for the entire listing lifetime; this resolves the source's unspecified linear anchor. Basis is perp impact-mid minus contemporaneous I. All three candidates must be valid in v1. Warm-up or missing depth means the normal mark is unavailable and only the explicit bootstrap fully-backed path may trade. Selected index/perp TWAP averages use the same validity-weighted timestamp discipline. A price movement exceeding 0.10 in five minutes activates reduce-only and monitoring; it does not replace the observed price with an invented smooth path. [B §13]

An unavailable independent index forbids all new exposure. An unavailable normal mark forbids leveraged exposure and, outside the explicit bootstrap path, voluntary market releases, funding authorization and mark-based liquidations. Free-balance deposit/withdraw and cancellation remain available if no account rollover conflict; allocation into a market may wait for its sweep. Price-free full-account takeover remains allowed only for the already-effective final-day backing floor or a proved nonpositive value in both endpoints; a stale mark alone is not evidence for discretionary liquidation. Freshness recovery requires a full valid observation window, not one signed tick. A source-update callback cannot change risk parameters. Before accepting a new observation, accrue or stop old-epoch funding against the previously known `fundingFreshThrough`. A late fresh observation cannot erase a historical freshness gap or restart funding in a stopped epoch.

## Pure functions and conservative arithmetic

The mathematical formulas in this subsection use **claims, USDC and days**, unlike ledger storage. Conversion into and out of this pure kernel is explicit. Given signed claims x and mark q, `w=q` for long and `w=1-q` for short. At x=0 return zero margin and zero directional leverage; never divide by x or equity. Horizon is $h=h_0+|x|/v$, with h0=300 seconds and v=1,000 claims/minute in the fixture profile. Measured keeper queue delay is an additional nonnegative horizon input; a cap cannot assume instantaneous liquidation.

Use conservative hazard bounds `a0=min(1,hazard0*hDays)` and `a1=min(1,hazard1*hDays)`. The source exponential probability is no greater than this bound for nonnegative hazards. These are separate upper bounds, not a normalized probability distribution. If `a0+a1>=1`, force full backing. Adverse hazard is a0 for longs, a1 for shorts. If adverse hazard is at least epsilon=0.01, force full backing. Otherwise:

$$\epsilon'={\epsilon-a_{adv}\over 1-a_{adv}},\qquad k=\sqrt{(1-\epsilon')/\epsilon'}.$$

Round adverse probabilities and k upward, epsilon' downward; if epsilon' rounds to zero, force full backing. For ordinary volatility use an upper bound

$$\sigma_h=\max\left(\sqrt{q(1-q)h/\max(T-t,1\mathrm{s})},\;\sigma_{realized,h},\;\sigma_{template,h}\right).$$

Both empirical inputs are nonnegative, nondecreasing upper envelopes in h, expressed as price-scale bounds; their time scaling and validity belong to the signed parameter manifest, not a guessed default. Missing or expired calibration forces full backing. Cap sigma at 1 only because the maximum binary price movement is 1, and cap margin by the exact bounded loss below.

Use conservative adverse drift envelopes `mLong=(1-q)*a1/(1-a0-a1)` and `mShort=q*a0/(1-a0-a1)`; dropping the favorable source terms can only increase the nonnegative drift allowance. Then compute

$$MM=\min\left(|x|w,\;|x|(m_{side}+k\sigma_h+s)+\tfrac12\lambda x^2\right),$$
$$IM=\min\left(|x|w,\;\max(\gamma MM,|x|w/L_{cap})\right).$$

Use gamma=1.5, s=0.005 and lambda=$10^{-6}$/claim only as fixture/calibration seeds. The selected fee model is linear in Q: an order reserves the ceiling of its total worst-limit fee once, then allocates that cumulative commitment to partial fills without independent atom ceilings. All nonzero trading fees must be added to s or covered by a larger measured bound. Use integer `sqrtUp`, `mulDivUp`, interval upper bounds and a full-backing fallback on domain exhaustion. Implement no normal inverse CDF and no external math API in the contract. Return `fullBackingRequired` explicitly whenever an IM cap meets bounded loss; the caller then checks both exact endpoints rather than relying on a rounded mark-equity comparison. [B §§6–8; DEC-09]

## Admission, maintenance and per-account concentration

Exposure increases, resting commitments and collateral release require `equity >= IM`. A below-MM account has no grace. An account between MM and IM can reduce/top up during its nonrenewable grace anchored to the risk epoch; touching it does not restart the clock. For voluntary/forced partial reductions of an initially positive-equity account, require `abs(xAfter)<abs(xBefore)`, no sign flip, both endpoint deficits nonincreasing after fees, `EAfter>=0`, and `EAfter-MMAfter >= min(EBefore-MMBefore,0)`, using one frozen price. Fully restoring IM is not required for a permitted partial reduction. For fresh E<=0 use the fee-free takeover branch; do not manufacture a negative-equity cash close. A reduction is not merely a smaller signed position: it must not flip side, increase either reserved outcome deficit, or violate the action's post-trade coverage/fee tests. Close through zero only by explicitly closing then admitting the other side as new exposure.

Directional caps after calibration are scheduled 5x/5x, continuous 3x/3x, deadline 3x long / 1x short, unscheduled 1x/1x. For initial deployment all are 1x. The model's tail/size constraints may impose a lower effective cap. Never set a hardcoded 5x margin ratio in place of this kernel.

At activation record seed reserve cashQ as `reserveCapBaseQ`. New exposure requires each account's worst endpoint deficit at most 2% of this immutable base. Live reserve donations do not automatically enlarge this cap; a new market version is required to change it in v1. Existing deficits can exceed it through accrued funding/premium, which triggers no new risk and a reduction flag, not a revert of mandatory accrual. This is a concentration control, not protection against wallet coalitions. The source $350-deficit/$10,000-reserve example breaches its own $200 cap; it is not a passing fixture here.

# Lifecycle and liquidation

## Time-derived rules and bounded reconciliation

| Effective stage | Exact time / cause | Allowed economic behavior |
|---|---|---|
| TRADING | Before T−12h30m and no stronger flag | Risk-checked exposure, resting orders, releases; ordinary hourly risk epochs |
| BACKING_GRACE | T−12h30m inclusive | New exposure must be fully backed; old deficient accounts have until T−12h to top up/reduce if not below MM |
| BACKING_FLOOR | T−12h inclusive | Funding frozen; invalidate all old order epochs; only fully backed new commitments; legacy deficient accounts eligible for bounded takeover |
| REDUCE_ONLY | T−1h inclusive or monitor restriction | No side flip / new absolute exposure; top-up and safe reduction only |
| HALTED | Earliest accepted oracle halt or T | No new ledger economics; frozen preparation and deterministic INVALID capture only |
| CLAIMS_READY | Finality + price + completed allocation | Independent once-only cash claims; no resumed trading |

An epoch rollover is an orthogonal accounting state. It pauses market ledger mutations until its bounded sweep finishes; it cannot postpone a more restrictive time stage or an oracle halt. Selected maximum batch is 32 traders per call, maximum 64 fills/examinations per match. Enforce a separate bound on examined stale/cancelled makers so adversarial orders cannot evade `maxFills`. Values are local-test defaults until gas is measured.

At the backing floor, mark `fullBackingReconciled=false`, invalidate orders, and expose a sweep cursor. Each step touches at the legal cutoff and takes over any account with negative E0 or E1; healthy accounts remain. The reserve stays in coverage throughout. Set the reconciled flag only after checking every frozen participant in that sweep; no clock-based shortcut. New joins are blocked during this reconciliation, preventing an ever-growing sweep. A halted market abandons further compression and uses the immutable halt snapshot; it need not finish liquidating to settle.

## Liquidation algorithm and failure rules

`liquidate(account,maxLots,maxBookExaminations)` is permissionless but chooses no arbitrary price. First derive stage and touch the account to the legal cutoff. Check eligibility before cancelling its live reservations. With fresh price it is eligible if E<MM, grace expired with E<IM, or the price-free backing floor applies. Noneligible attempts return a labeled no-effect result after any harmless permitted synchronization; do not pay a keeper reward.

1. **Pair reduction:** accept at most one explicitly supplied opposite eligible account per call. Recheck both; close only the minimum of requested lots and both absolute positions. Use `tick=clamp(floor(qWad/10**15),1,999)` as the single common execution price; the at-most-one-tick deviation is visible in the event and included in closeout bounds. Require post-fill health not worse for either under the liquidation predicate and both outcome coverage checks. Otherwise skip pairing. No unbounded search is performed onchain.
2. **Bounded book close:** submit a reduce-only IOC through the same risk hooks. Respect requested size, per-block market liquidation-lot budget and examination cap. For a long, require cash+remaining-position mark equity after the sale and fees not below its allowed bankruptcy threshold; for a short apply the mirrored condition. Derive a worst permissible tick by signed integer inequalities including fees, then recheck actual results at every fill. A stale maker is pruned under the normal hook protocol.
3. **Takeover:** if E<=0, or the effective backing floor finds an endpoint deficit, transfer the entire remaining account cash and position to reserve in one atomic posting after cancellation. Caller work limits and lack of liquidity never satisfy this condition by themselves. Zero account obligations and residual premium state, increase account order epoch, and enforce both outcome coverage checks. No external USDC payment occurs; no new takeover fee is charged.

For initially positive equity, the source size estimate is only an optimization:

$$g=IM-E,\quad i=IM/|x|,\quad\Delta={2g\over(i-s)+\sqrt{(i-s)^2-2\lambda g}}.$$

Use it only for g>0, i>s and nonnegative discriminant. Otherwise choose a full close attempt. Round lots upward, clamp to the position, and recompute actual margin after fees and the new size-dependent horizon. If the estimate undercloses, continue within call bounds or return `NEEDS_MORE_WORK`. Insufficient liquidity, caller maxLots, or examined-maker exhaustion alone never authorizes positive-equity takeover. It remains reserve-covered for later reduction. Reject zero liquidation work budgets; do not reward an incomplete no-effect call. Never assert that this approximate formula guarantees restored health.

Executed book/pair liquidation fee is 0.001 USDC per claim closed, hence exactly **one atom per lot**; allocate half in Q to reserve and half to `keeperPayableQ`. Charge only if its full posting satisfies the liquidation predicate and coverage; otherwise reduce/waive the fee and emit the charged amount. Withdraw keeper fees only as floor(Q/Qscale) atoms while retaining fractional residue. A takeover pays no fee. A malicious keeper cannot create a payout by repeatedly calling a zero-effect liquidation.

Reserve inventory may later unwind only through ordinary paired fills that reduce absolute reserve position without flipping it and preserve both outcome coverage. Reserve has no discretionary withdrawal path and cannot use a favorable mark to spend guaranteed terminal backing. Measured `maxLiqLotsPerBlock` is a deployment input; if missing, ordinary mark-based forced-book liquidation is disabled and launch remains 1x, while price-free floor takeovers and terminal settlement remain available.

# Configuration, roles and operational interfaces

## Reproducible local profile and production inputs

The local fixture profile is executable, not a calibrated production recommendation. Use zero trading fees, scheduled template, list T at 10 days, reserve seed 100,000 USDC, maximum 1,024 traders, minOrderLots=1, maxOrderLots=$2^{32}$, maxAbsPositionLots=$2^{40}$, batch size 32, examined-maker cap 64, h0=300 seconds, v=1,000 claims/minute, epsilon=.01, gamma=1.5, s=.005, lambda=$10^{-6}$, hazard0=hazard1=.0001/day, premium load=1, new-deficit multiplier4, surcharge6h, funding alpha=1/day, beta=0, kappa=.05/day, epoch1h, notice7d, stale30s and movement trigger .10/300s. Fixtures that need leverage explicitly set the simulated template cap 5 and declare empirical volatility inputs; deployment defaults remain1.

A production manifest must supply source addresses/signers/domain, N depth, empirical volatility bound/floor, stressed spread and impact, closeout speed and queue delay, liquidation block cap, position/OI limits, template hazards with validity interval, token/code hashes, gas measurements, compiler/dependency lock hashes and counterpart ABI version. Missing values fail the activation gate or force fully backed mode. There is no `TODO: pick a number` branch for an agent to fill silently.

Live hazards may only be raised by an authenticated monitor request. Apply a raise immediately as reduce-only, then at the next completed risk/accounting epoch with a fixed profile hash; do not retroactively reprice accrued premium. Other risk changes use the deployment's explicit governance/timelock process and never rewrite market question, T, INVALID rule, source identity or a final outcome. The engine deployment manifest must name the actual governance implementation and delay before any production activation; a test harness role is not a production timelock.

## Minimal role matrix

| Action | Authorized actor | Restriction |
|---|---|---|
| Allocate/release collateral, submit/cancel user order | Account owner or scoped signed delegate | Nonce/deadline/domain verified by router; risk checks still apply |
| Post matched pair | Internal matcher composition only | No public arbitrary ledger mutator |
| Read prices / deliver observation | Pinned adapter, authenticated data | Cannot change balances, rule config or outcome |
| Raise concern / request reduce-only | Pinned monitor | Cannot halt economically, lower hazards or finalize |
| Materialize scheduled halt / sweep / prepare / liquidate | Anyone | Deterministic time/data predicates, bounded work |
| Halt early / accept final outcome | Pinned ResolutionOracle only | Once-only immutable economic cutoff/outcome |
| Claim trader/keeper/reserve entitlement | Entitled owner, or permissionless pay-to-owner wrapper | Recipient fixed to entitlement owner; no arbitrary drain |
| Seed capital / configure preactivation | Configured capital/governance authority | Live seed/share restrictions enforced |

## Views, events and errors are deliverables

`previewAccount` returns named units for cash, position, projected funding/premium, E0/E1, mark equity, IM/MM, fullBackingRequired, current order bounds, usable release atoms, risk/accounting epoch, price validity and stage. `previewOrder` includes rejection reason, required margin, incremental endpoint deficits and reserve slack before/after. A preview is valid only for its block/config/price snapshot; transaction execution repeats checks.

Expose progress for epoch sweep, backing sweep, halt snapshot, INVALID capture and payout preparation. The frontend must show `ORACLE_FINAL_PRICE_PENDING`, `ORACLE_FINAL_PREPARING` and `CLAIMABLE` distinctly. Present zero/unknown as distinct values; an unavailable mark is not price0.

Emit deposits/allocation/release, paired fill, fee movement, account synchronized, funding epoch authorized/ended, premium charged, reservation changed, maker pruned, takeover, stage/sweep progress, halt/finality, INVALID capture, claims-ready and claim-paid events. Include marketId, account/order IDs, units by schema, epoch/config hash, cutoff, before/after quantities where reconstructing the ledger requires them. Do not emit only a display P&L delta.

Use stable reason codes: `BAD_UNITS`, `UNAUTHORIZED`, `BAD_NONCE`, `STALE_PRICE`, `INVALID_DEPTH`, `EPOCH_ROLLING`, `ACCOUNT_LIMIT`, `STAGE_FORBIDS`, `REDUCE_ONLY`, `INSUFFICIENT_IM`, `DEFICIT_CAP`, `RESERVE_COVERAGE`, `FUNDING_EXHAUSTED`, `STALE_RESERVATION`, `CONFLICTING_FINALITY`, `INVALID_PRICE_PENDING`, `PREPARATION_PENDING`, `ALREADY_CLAIMED`. Expected matcher capacity failures use returned statuses; authorization/arithmetic/invariant violations revert. Record partial-fill/no-effect reasons in events and return values.


## Funding rate and activation gates

At an eligible epoch opening, compute daily per-claim funding `f=clamp(q-I, -0.05*min(I,1-I), +0.05*min(I,1-I))`. This is source alpha=1/day with beta=0; the source endpoint amplification term is disabled in v1. Convert once to `r=truncTowardZero(f*1000*Q/86400)` Q per lot per second. Price inputs must be valid then. The rate remains fixed for that epoch regardless of later fills; the budget and freshness cutoff can stop it earlier. Initial zero OI disables funding for the entire epoch; no second authorization is created when its first trade arrives.

Use `fundingEnabled=false` and all directional caps1 in the initial deployment manifest. Local tests explicitly enable funding and leverage. Enabling them for a new deployment/version requires the reference/invariant and integration gates, measured market depth/queue/calibration, funded reserve, parameter limits and security review. This is a release gate, not permission to omit the code or leveraged fixtures.

## Fee escrow and exceptional recovery

Before reserve residual is assigned at settlement, move exact protocolFeeQ and keeperPayableQ into separately recognized global vault fee escrows using internal bookkeeping. Reduce this market's allocationQ by exactly those Q amounts; do not perform a rounded token transfer. Fee escrows retain beneficiary-owned fractional Q and pay only floor(balanceQ/Q) external atoms on withdrawal. Fractions remain liabilities and cannot be swept into reserve LP residual. This reclassification may leave a fractional market allocationQ; aggregate custody accounting remains exact across all categories.

Normal settlement uses covered market allocation plus the reserve already inside it. A shared backstop promise is not an asset. The v1 shared backstop is a pre-funded per-market allocation capped at 20% of immutable reserveCapBaseQ, with no repayment claim against this market; unused unallocated funds stay in the backstop. An authorized finalized-market contribution becomes irrevocable reserve cash before payout allocation. No first-come shared-pool promise is counted in admissions.

If complete frozen trader claims exceed actual recognized available market assets after the named fee escrows and allowed backstop contribution, `finishPreparation` returns `RECOVERY_REQUIRED` and cannot open claims. The baseline registry fixes `recoveryEnabled=false`; no administrator may haircut an existing baseline market. Implement the recovery calculator and its tests as a disabled extension: for an explicitly prelisted recovery-enabled market, freeze available Q assets A and total positive raw Q claims P, fix rho=min(1,A/P), and pay each account `floor(rawClaimQ*rho/Q)` atoms. Use full-precision rational products; do not round rho upward. P=0 has no trader payouts. Freeze all amounts before claims, and route unallocated rounding dust to the named reserve residual. At terminal reserve allocation, define `reserveResidualQ` only after trader claim atoms and exact fee escrows are removed; `reserveResidualAtoms=floor(reserveResidualQ/Q)`. Any reserve-owned remainder below one atom credits the immutable reserve treasury Q escrow. Allocate LP floor entitlements from reserveResidualAtoms; their aggregate atom dust also credits that treasury. Thus every Q remains classified. The extension can be activated only for a new disclosed listing after its separate test/review gate; it is not an improvised response to a live custody failure. A custody-wide shortfall or token freeze needs an independently authorized recovery process and is outside this market-local code path.


## Canonical state names and counter widths

Use `Stage { TRADING, BACKING_GRACE, BACKING_FLOOR, REDUCE_ONLY, HALTED, CLAIMS_READY }` for the economic view, `AccountingState { READY, ROLLOVER_SWEEP, FLOOR_SWEEP, HALT_SWEEP }` for work gates, and `PricingMode { BOOTSTRAP, NORMAL_PRICING }` for mark readiness. `ClearingPhase` below tracks payout preparation independently. Conceptual labels such as “1x floor” mean BACKING_FLOOR; do not create competing lifecycle enums in separate modules. New risk-facing order quantities and epochs use uint64. Packed book quantities remain bounded by their narrower representable range; reject overflow and preserve full epochs in a generation-bound sidecar. No implicit truncation to a packed slot is allowed.

Every successful closeout, epoch or settlement batch emits its cursor and immutable generation. Offchain jobs retry idempotently and alert on lack of progress. Do not delete zero-position participants: they can still own cash, fee residues or claims. Initial trader bound1,024 and reserve shareholder bound256 are separate, finite registries.


# Funding, premiums, epoch accounting and reserve capital

## Ledger and custody identities

For effective current cash `c`, outcome values are `E0=c`, `E1=c+x*PAYOFF_Q_PER_LOT`. Full backing is both nonnegative. Mark equity is separate and never used to derive settlement cash.

A matched fill applies opposite changes to position and cash in one atomic transaction. Cash fees and premium transfers credit the receiving ledger by **exactly** the debit amount. No economic function can shrink a position without its counterparty or transfer the whole position/cash to reserve.

Because funding is lazy, stored account cash alone does not sum to custody before a sweep. Keep an explicit signed `fundingClearingQ` contra ledger. When booking account funding payment `p`, perform `cashQ -= p; fundingClearingQ += p`. Thus:

`marketAllocationQ = sum(trader booked cashQ) + reserveCashQ + protocolFeeQ + keeperPayableQ + explicitResidualQ + fundingClearingQ`.

The reserve funding payment is booked immediately on every global funding accrual and uses the same contra ledger. At a complete common-index sweep, `fundingClearingQ == 0`; this is a hard epoch and finalization assertion. Pending funding cash is represented exactly and must never be treated as protocol revenue or withdrawable reserve cash.

Shared custody obeys `recognizedVaultAtoms*Q = freeBalancesQ + sum(marketAllocationQ) + explicitly classified global custody categories`. Standard user free balances may be atom-granular. No OutcomeVault may hold additional unclassified custody. For the baseline it is disabled, so all collateral stays in CollateralVault.


## Funding: exact changes in OI, reserve position and coverage

### Epoch-fixed rate

At successful epoch opening, select B's clipped basis rate with beta=0, quantize toward zero to signed `r` Q units/lot/second and keep its sign/rate fixed until the epoch ends. A zero rate produces no funding movement. New exposure at 1x must have enough headroom for any later realized funding or be stopped by coverage/health rules; the pre-final 1x product is not promised never to need a small top-up. Funding is zero for baseline-only1x deployment until the funding feature gate passes.

`F(t)=Fstart+r*(min(t, effectiveStopAt)-epochStart)`.

There is at most one stop per epoch. Stop permanently for the remainder of that epoch on budget exhaustion, index staleness, the T−12h funding deadline, or halt. Fresh data never resumes an already stopped epoch. For sub-second chains, economic timestamps remain integer seconds; same-second funding is zero. Clamp all elapsed time to the epoch's immutable end.

### Preauthorize cash, not an index displacement

At epoch open, after all accounts are at one index and deficits are exact:

`B=min(requestedFundingCashBudget, max(0,min(R0-D0,R1-D1)))`.

Requested budget is `OI_allLots*abs(r)*epochSeconds`. Later OI increases do not increase B. Every OI-changing transition first accrues with the **old** OI up to its timestamp, then synchronizes touched accounts, then mutates positions/OI. Future seconds consume budget at new OI. An initial zero-OI epoch leaves funding disabled for that whole epoch. A subsequent return to OI=0 stops funding for the rest of an active epoch. No newly created position is charged for a zero-OI past; funding resumes only at a later completed epoch opening.

On accrual, choose the largest integer number of seconds `dt` such that `OI_allLots*abs(r)*dt <= B`. Advance only these seconds. If current elapsed seconds exceed dt, record exact stop time and keep rate stopped for the epoch; any sub-second budget remainder remains unused. No net-index-displacement test is used.

### Correct funding deficit cushion

Define `Dbar[y]=sumStoredDeficit[y]+fundingCushionQ`. All stored deficits are each account's last synchronized valid-order state. The cushion bounds only **unmaterialized positive trader funding debts**, not reserve debt and not funding recipients.

For index increment `dF` and current total one-sided OI in lots:

`totalFundingFlow = OI_allLots * abs(dF)`

`reservePayment = reservePositionLots * dF` (signed; positive means reserve pays)

`traderPayerFlow = totalFundingFlow - max(reservePayment,0)`.

Then atomically:

- `B -= totalFundingFlow`;
- `fundingCushion += traderPayerFlow`;
- `reserveCash -= reservePayment`;
- `fundingClearing += reservePayment`;
- `F += dF`.

This distinction is essential. Adding total OI flow to Dbar while also reducing reserve cash can overcharge the same reserve-funded transfer and falsely breach coverage. The above update preserves slack: a reserve payer loses exactly the part of budget not added to trader deficit cushion; a reserve recipient increases slack.

When trader i synchronizes, compute signed payment `p=x_i*(F-Fi)` and perform:

1. Remove its old `storedDeficit[y]` from the stored sums.
2. `cash_i -= p; fundingClearing += p`.
3. `fundingCushion -= max(p,0)`.
4. Set `Fi=F`; book premium as described below; clear invalid reservations and recompute both stored deficits; add them to sums.

The fixed sign inside an epoch and mandatory end sweep make `max(p,0)` exactly the previously attributed unmaterialized payer flow. No rate reversal or stale checkpoint can span two epochs. A receiver cannot worsen either deficit. A payer's deficit rises by at most p. Premium increases reserve by at least the induced deficit increase. After complete sweep, cushion and clearing are both exactly zero.

Check after every committed state change:

`R0=reserveCashQ`

`R1=reserveCashQ+reservePositionLots*PAYOFF_Q_PER_LOT`

`R_y >= Dbar[y]+B` for both y.

A parameter change may reduce exposure/caps but cannot enlarge funding B or release reserve without this test. Stored Dbar bounds cash after pending funding but before unposted premium. Pending premium P increases effective reserve cash by P and trader deficits by at most P, so it preserves the stated guarantee. No unbounded recomputation and no subtraction from cushion based on guesses.


## Premium: exact, deterministic, noncompounding within an epoch

The source formula `D_current * (H-Hcheckpoint)` is rejected as an exact accounting rule. Funding changes D, premium itself changes D, and elapsed hazard/surcharge segments are not represented by one current D.

Define the tariff explicitly. During an epoch:

`principalCash_i(t)=effectiveCash_i(t)+premiumPostedThisEpoch_i`.

The added-back quantity is only this epoch's premium, not fees, funding or previous epochs' premiums. Let

`principalDeficit_y(t)=max(0,-(principalCash_i(t)+x_i*PAYOFF_Q_PER_LOT*y))`.

Charge

`premium = integral [(1+load)*hazard_y*multiplier_i(t)*principalDeficit_y(t)] dt`, summed over outcomes, with hazard measured per second.

Between economic mutations, principalCash is affine in time while funding runs and constant after its one stop. The 4x multiplier has one possible expiration at `surchargeUntil`. Split integration at funding stop and surcharge expiry; integrate the positive part of an affine function exactly using rational mulDiv. For `z(t)=a+b*t`, use a trapezoid if endpoints are nonnegative, zero if both nonpositive, or a clipped triangle with crossing `-a/b`. No floating point and no repeated sampled approximation.

A segment begins at epoch start or a genuine principal/position mutation (deposit, withdrawal, fill, trading fee, takeover). Keep its origin `a,b,start` and cumulative integral posted. Pure account sync does **not** reset the segment origin. Charge `ceil_Q(cumulativeSegmentIntegral(now))-alreadyPostedForSegment`; this makes neutral touch frequency irrelevant. Round a segment's fee upward only in internal subunits, then debit and credit exactly the same integer amount. Segment changes realize the old segment before opening the next. A funding stop is read from the epoch state, not guessed from current price.

On posting fee p: `traderCash -= p; premiumPostedThisEpoch += p; reserveCash += p`. PrincipalCash does not change from that posting, so no touch-dependent intra-epoch compounding occurs. Risk health and reserves use actual cash including posted premium, not the premium-excluded principal tariff base. Health views include accrued but unposted premium via the same pure calculator. Premium is paid only on realized position principal deficits, not on unfilled order reservations; orders still reserve full jump coverage.

At the epoch-end sweep, finalize all segments at the same epoch cutoff. Only after every account is settled, set each next-epoch `premiumPostedThisEpoch=0` and initialize its new principal base from actual cash. This capitalizes the completed epoch's premiums deterministically once. When sweeping, store the next-epoch base without starting its economic clock until the last page completes. No premium accrues during the processing pause: the source did not specify pause economics, and this baseline makes them explicit. Reserve still covers terminal jump exposure during the pause.

A monitor increase changes immediate allowed risk/mode but the premium tariff updates only at the next epoch opening. For suspected decisive news, force reduce-only; do not keep selling increased cover at the old tariff. Accounts already outstanding remain covered. Calibration and reserve LP economics must use this discrete tariff, not the source's continuous-compounding claims.


## Epoch rollover is a real state, not an invisible keeper assumption

At timestamp>=epochEnd, any call derives `AccountingRollover` and no new order/fill/release is permitted. Deposit top-ups may be recorded to free collateral but market allocation waits until rollover completes, avoiding mutable snapshot data. A bounded permissionless `rollEpoch(maxAccounts<=32)`:

1. First page freezes global F/premium cutoff at epochEnd, cancels market order epoch, freezes accountCount and stops trading/release.
2. Each account is synchronized at the **same cutoff**, invalid order commitments cleared, premium finalized and source MM/IM health noted.
3. Last page asserts cash custody, fundingClearingQ=0, fundingCushion=0 and recomputes exact deficit sums.
4. If not halted and before scheduled halt, begin a new epoch at the completion transaction's timestamp, ending at the next fixed wall-clock hour boundary (or earlier funding/final-day boundary). Skipped empty time accrues neither funding nor premium. Do not run thousands of missed hourly epochs after an outage.
5. Recalculate rates/tariffs, authorize B from coverage and open trading only under the derived lifecycle restrictions.

Halt overrides this process immediately. Its accrualCutoff is min(haltEventTime, activeEpoch.end), even if no rollover page has started. Keep economicHaltAt separately as the scheduled T or actual early halt time. Halt and directs remaining pages into final snapshot. Mid-rollover pages already posted to the same cutoff remain valid; never double-charge or extend cutoff to processing time. An external oracle outcome never waits for a keeper roll.


## Reserve LP accounting and liabilities

Reserve shares are **risk equity**. They are not a senior payable deducted from reserve and simultaneously counted as available cover. A withdrawal request locks shares/starts notice; it creates no fixed USDC liability before redemption is admitted. All active reserve capital is available to cover admitted trader deficits.

Baseline ReserveVault: deposits/mint1:1 only before explicit activation and before any market trade; no active share issue/redeem; share transfers disabled while active to avoid unsupported secondary NAV assumptions. `maxDeposit/maxMint/maxWithdraw/maxRedeem` return0 as appropriate during active lock. Seven-day notice must mature and final snapshot must allocate all trader claims into escrow before redemption. Matured notices redeem at final actual residual pro rata after protocol and keeper Q liabilities are reclassified into their dedicated escrows, irrespective of whether individual traders have clicked claim.

ReserveVault is a minimal locked-share module, **not advertised as a general live ERC-4626 vault**. This deliberately deviates from B's live ERC-4626 LP architecture. Mint1 share per deposited USDC atom before activation; initial shares are exactly proportional to deposit capital. After activation, all top-ups are donations/backstop transfers and issue no shares. `maxWithdraw` and `maxRedeem` are0 until final user claims have been escrowed and the account's seven-day notice matures. No function uses a live mark to mint or redeem shares.

The dashboard may report `max(0,min(R0-Dbar0-B,R1-Dbar1-B))` strictly as a conservative coverage slack, never as a tradable LP NAV. Final share entitlement is `floor(finalReserveResidualAtoms * userShares / totalSharesAtFinal)`. Allocate every shareholder's floor amount from a frozen registry, and send unallocated aggregate atom dust and reserve-owned fractional Q to the immutable configured reserve treasury Q escrow; no final-redeemer windfall depends on claim order. Baseline caps the preactivation shareholder registry at 256. All redeemed-share amounts use the frozen total, not a changing residual/share ratio. Claim escrow exists before reserve unlock, so users and LPs cannot race for the same cash. Fairly priced live issuance/redemption is a later independently gated extension.

Shared backstop is not part of normal admission coverage. Only capital irreversibly allocated into this market reserve counts. A separately capped backstop transfer must become real market cash before it can permit new leverage. No cross-market promise or expected injection counts toward R.


## Coverage proof and executable synchronization pseudocode

Let `S_y=sumStoredDeficit[y]`, `C=fundingCushion`, `B=futureFundingBudget`, and slack `J_y=R_y-S_y-C-B`. Initially after sweep, C=0. During the epoch, C is exactly the sum over untouched trader **payer** funding amounts since their checkpoints; source risk Dbar is S+C. Funding is fixed-sign, so a trader's accumulated positive debit is simply `max(x*(F-Fi),0)` and cannot hide a positive-then-negative path.

For an accrual, let total payer transfer be A, reserve signed payment be p, and trader-payer contribution be `a=A-max(p,0)`. The update is `Delta R=-p; Delta C=a; Delta B=-A`, hence

`Delta J = -p-a+A = max(-p,0) >= 0`.

For a trader sync, let signed funding payment be p and newly booked premium be z>=0. Removing the trader's old contribution and replacing it gives change in S of `dNew-dOld`, while C falls by `max(p,0)` and reserve grows by z. Since each outcome deficit is 1-Lipschitz in cash debit,

`dNew-dOld <= max(p,0)+z`,

so `Delta J=z-(dNew-dOld)+max(p,0)>=0`. Clearing an invalid order can only improve this. User mutations then require an ordinary full post-action coverage check; they are not covered by this sync-only proof.

```text
accrueGlobal(now):
    assert current accounting epoch is initialized
    clamp now to epoch cutoff, funding floor, halt cutoff, fundingFreshThrough
    if funding already stopped or rate == 0: return
    if OIall == 0: stopFunding(lastAccruedAt); return
    elapsed = clampedNow-lastAccruedAt
    affordableSeconds = B // (OIall * abs(rate))
    dt = min(elapsed, affordableSeconds)
    deltaF = rate * dt
    A = OIall * abs(deltaF)
    pReserve = reserveLots * deltaF
    C += A-max(pReserve, 0)
    B -= A
    reserveCashQ -= pReserve
    fundingClearingQ += pReserve
    F += deltaF
    lastAccruedAt += dt
    if dt < elapsed: stopFunding(lastAccruedAt)
    assertCoverage()

syncTrader(account, cutoff):
    # Caller already accrued global funding to permitted cutoff.
    old0, old1 = account.storedDeficits
    S0 -= old0; S1 -= old1
    p = account.lots * (F-account.Fcheckpoint)
    C -= max(p, 0)  # Cannot underflow; otherwise invariant failure.
    account.cashQ -= p
    fundingClearingQ += p
    account.Fcheckpoint = F
    z = cumulativeSegmentPremiumQ(cutoff)-segmentAlreadyPostedQ
    account.cashQ -= z
    reserveCashQ += z
    account.premiumPostedThisEpochQ += z
    segmentAlreadyPostedQ += z
    clearInvalidOrderReservations(account)
    d0,d1 = recomputeOutcomeBounds(account)
    account.storedDeficits = d0,d1
    S0 += d0; S1 += d1
    assertCoverage()

applyFill(maker,taker,lots,tick):
    accrueGlobal(blockTimestamp)             # OLD OI and reserve position.
    syncTrader(maker, permittedNow)
    syncTrader(taker, permittedNow)
    closePremiumSegments(maker,taker)
    validateCurrentMakerAndTakerStates()
    removeOldStoredBounds(maker,taker)
    applyExactOppositeLotAndCashChanges()
    applyExactFeesAndUpdateOrderReservations()
    updateAllAccountOIContributions()        # NEW OI applies only after now.
    updateSurchargeDeadlinesForFreshUserDeficits()
    initializeNewPremiumSegments(maker,taker)
    addRecomputedStoredBounds(maker,taker)
    assertMarginAdmissionOrAuthorizedReduction()
    assertCoverageAndCustody()
```

`permittedNow` is the common economic cutoff, never processing time after rollover or halt. Account pure sync posts a cumulative amount but retains its premium segment origin. A caller must not sync the same state again at a different implicit cutoff. A market action that reallocates reserve cash/position applies identical global accrual ordering first.

### Numeric coverage fixtures (USDC shown, implementation uses Q)

**No reserve position.** Traders have+100 and−100 claims. Start R=20, Dbar=10 and B=5, hence minimum slack5. Funding index advances+.01 USDC/claim: A=1, reserve payment0, C increases1, B decreases1. R−Dbar−B remains5. The payer sync materializes at most1 extra deficit and removes exactly1 from C; no double count remains.

**Reserve is a payer.** Reserve+40, trader A+60, trader B−100; OIall=100. At deltaF+.01, total A=1, reserve p=.4, trader payer a=.6. R falls.4, Dbar grows.6, B falls1: slack unchanged. The incorrect source-like update Dbar+=1 would artificially lower slack by.4.

**Reserve is a receiver.** Reserve−40, trader A+100, trader B−60. A=1, reserve p=−.4, trader payer a=1. R grows.4, Dbar grows1, B falls1: slack improves.4. All trader/receiver materializations later leave exact zero clearing at common F.

**OI increases mid-epoch.** Rate.001 USDC/claim/sec, oldOI100, B10. After20 seconds accrue2, leavingB8. A new matched trade raisesOI to 200 after synchronizing its accounts. Funding then costs.2/sec, so at most40 more seconds accrue; no implicit reauthorization occurs. If observed80 seconds later, cutoff is the affordable40th second, not the call time.

**Zero-sum funding.** Positions+60,+40reserve,−100 and deltaF.01 yield signed payments+.6,+.4,−1 exactly. Internal debits equal credits at full common-index materialization. No payer-ceil/receiver-floor mismatch exists. Cash withdrawal rounds only the external payable amount to atoms; its retained fractional remainder remains owned by the account until final dust allocation, not mysteriously destroyed on each sync.

**Premium time-neutrality.** Principal deficit starts100 USDC and fixed funding grows it to 110 over one hour. Loaded hazard tariff.0002/day produces integral`105*.0002/24=.000875USDC` before rounding. Syncing at 30 minutes then60 minutes must charge the same cumulative Q result as syncing only at 60 minutes. An initial4x surcharge gives.0035 USDC. A genuine trade at 30 minutes ends the first economic segment and applies stated upward-Q rounding there; total rounding error is less than oneQ per nonzero rounded segment, not an unbounded atom per touch.

**Premium capitalization.** If initial principal deficit100 incurs1 of premium over an epoch with no other changes, actual deficit becomes101 and reserve grows1, while the same epoch's tariff continues using100. At next epoch's committed opening, the new principal base is 101. Touch frequency cannot induce continuous compounding within that completed epoch.



## Rollover and halt storage discipline

Account pages must not erase the current epoch's premium-posted value before the global epoch commits. Store `settledThroughEpochId`, cutoff balances and a staged next base. Processing a page marks it complete once; a repeated page has no effect. Only the final global epoch-commit changes `activeEpochId` and makes staged next bases effective. A halt during rollover preserves economicHaltAt and adopts that epoch's already frozen accrual cutoff; its snapshot reuses completed pages and processes remaining pages exactly once. Never iterate by only currently nonzero position: zero-position accounts can still have cash, accrued fees/premium or claims and remain in the frozen registry.

The initial preactivation reserve shareholder cap and active trader cap are engineering bounds with separate registries. A share notice does not freeze an amount; it freezes share quantity. Redemptions after finalization read the immutable per-shareholder entitlement and cannot reprice from a decrementing cash pool.


# Risk & Clearing ↔ Order Book integration contract

This is the **selected implementation seam**, not a quotation from the PDFs. It resolves ambiguities in source B §§4, 9, 11, 12, 16 and 17 so the two Risk & Clearing developers can work independently of the book and oracle teams. Economics follow B: signed cash/position ledger, per-outcome reserve coverage, accrued funding/premium, and internal per-market settlement. Do not import D's entry-notional ledger, six-hour floor, dual-index liquidation, or pre-settlement bad-debt cash payment.

## Ownership and non-negotiable boundary

The book team owns tick discovery, FIFO links, packed order slots, free-list/generation handling, matching traversal, order amendments and physical pruning. Risk & Clearing owns accounts, admission, all reservations, funding/premium settlement, fee accounting, position/cash transfers, deficit contributions, coverage, stages and epochs. The oracle team supplies already-validated market state through a separate boundary. The Risk & Clearing module consumes that state; it does not call external price/oracle contracts inside matching.

All functions below are internal calls in the same per-market engine. Neither side may use token transfers, external contract calls, untrusted callbacks or external self-calls in the matching loop. USDC allocation/deallocation occurs at entry/exit custody boundaries outside matching under the engine's reentrancy discipline. Solidity atomicity is the final protection: an unexpected accounting postcondition failure reverts the entire transaction, including every preceding fill, cancellation, premium settlement and emitted log.

| Responsibility | Risk & Clearing developer A | Risk & Clearing developer B | Book team |
|---|---|---|---|
| Ledger and accrual | Own `_touchAccount`, paired fill accounting, exact units, fee/reserve postings | Consume A's settled-account state | Never changes cash, position or checkpoints |
| Reservation/risk | Own cash and contribution replacement primitives | Own admission, safe-size cap, IM, full-backing and both-outcome checks | Calls admitted lifecycle hooks exactly once |
| Epochs/stages | Atomic state transitions and account epoch storage | Time-derived policy and invalidation conditions | Stores admission epoch on each order; skips stale orders |
| Fill execution | One atomic paired ledger mutation | Preflight + post-fill risk/coverage validation | Traverses FIFO and applies approved order-size changes |
| Events | Account, coverage and policy events | Rejection/status codes | Order topology events and canonical paired Fill event |

The canonical state names and widths in the earlier contract are binding. The types below are an explicit shared contract, not an instruction to implement the book itself.

## Exact units and core data

One lot is 0.001 claim, one tick is 0.001 USDC/claim, and one USDC atom is 10⁻⁶ USDC. **Locked internal precision:** `Q = 10^18`, `cashQ = USDC atoms × Q`. Therefore a fill transfers `notionalQ = lots * tick * Q` exactly; one YES-winning lot pays `1000 * Q`. Signed positions remain integer lots; all internal cash, fees, reservations and deficits use cashQ. Terminal YES value is `cashQ + 1000 * Q * positionLots`. A risk mark `qWad` already has scale Q, so `markValuePerLotQ = 1000 * qWad`. External custody rounds only at the defined USDC-atom boundary using the canonical payer/receiver policy; no intermediate fill converts internal Q amounts down to atoms.

```solidity
// Contract-level declarations: snippets specify a seam, not a complete library.
enum Side { BUY, SELL }
enum OrderKind { LIMIT, IOC, POST_ONLY }
enum Stage { TRADING, BACKING_GRACE, BACKING_FLOOR, REDUCE_ONLY, HALTED, CLAIMS_READY }
enum AdmissionMode { NORMAL, VOLUNTARY_REDUCTION, FORCED_REDUCTION }
enum RemovalReason {
    USER_CANCEL, EXPIRED, STALE_MARKET_EPOCH, STALE_ACCOUNT_EPOCH,
    STALE_REDUCE_VERSION, SELF_TRADE, FAILED_READMISSION,
    FILLED, REDUCE_ONLY_EXHAUSTED, CROSSED_REMAINDER, REPLACED
}
enum StepStatus { FILLED, PRUNE_MAKER, STOP_TAKER }
enum RejectCode {
    NONE, HALTED, BAD_STAGE, OUTSIDE_BAND, BELOW_MIN_SIZE,
    NO_REDUCIBLE_POSITION, MAKER_BELOW_IM, MAKER_BELOW_MM,
    TAKER_CAPACITY, ACCOUNT_DEFICIT_CAP, MARKET_COVERAGE,
    INVALID_PRICE_OR_SIZE, STALE_ORDER
}

struct OrderKey {
    uint32 slot;
    uint24 generation;
}

struct EpochTag {
    uint64 marketOrderEpoch;
    uint64 accountOrderEpoch;
}

struct AccountCore {
    int128 positionLots;
    int256 cashQ;
    // Funding/premium checkpoints belong to the canonical accrual module.
    uint64 orderEpoch;
    uint64 positionVersion;
}

struct OrderSums {
    uint128 bidLots;        // Qb
    uint256 bidValueQ;  // Vb = sum(lots * limitTick * 1e18)
    uint128 askLots;        // Qa
    uint256 askValueQ;  // Va = sum(lots * limitTick * 1e18)
    uint256 feeCapQ;    // conservative future fees on the commitments
    uint16 maxBidTick;      // conservative admitted upper bound; zero if none
    uint16 minAskTick;      // conservative admitted lower bound; 1000 if none
    EpochTag tag;           // all sums refer to this reservation epoch only
}

struct OrderView {
    OrderKey key;
    uint32 owner;
    Side side;
    uint16 tick;
    uint64 remainingLots;
    uint32 expiryBlock;       // zero = no block expiry
    EpochTag admittedAt;
    bool reduceOnly;
    uint64 reduceVersion;     // meaningful only for reduce-only orders
    uint256 remainingFeeCapQ;  // reservation amount still attributable to order
}

struct OrderRequest {
    uint32 trader;
    Side side;
    OrderKind kind;
    uint16 limitTick;
    uint64 requestedLots;
    uint32 expiryBlock;
    bool reduceOnly;
    uint16 maxSteps;
}

struct RiskSnapshot {
    uint64 marketOrderEpoch;
    uint64 riskVersion;
    uint64 economicTime;
    Stage stage;
    uint256 indexWad;
    uint256 markWad;
    int256 fundingIndex;
    uint64 accountingEpochId;
    uint64 premiumCutoff;
    bytes32 premiumTariffHash;
    // Fixed fee/risk parameter identifiers, not external pointers.
    uint64 feeVersion;
    uint64 parameterVersion;
}

struct TakerPermit {
    uint64 localPermitId;      // unique only inside this transaction
    uint32 trader;
    Side side;
    uint16 limitTick;
    uint64 remainingLots;
    uint256 remainingFeeCapQ;
    uint64 reduceVersion;
    bool reduceOnly;
    AdmissionMode mode;
}

struct StepResult {
    StepStatus status;
    RejectCode reason;
    uint64 filledLots;
    uint256 notionalQ;
    uint256 makerFeeQ;
    uint256 takerFeeQ;
    uint64 makerRemainingLots;
    uint64 makerPostFillVersion;
    bool removeMakerRemainder;
}
```

**Accepted maker version (RB-I02).** For a successful reduce-only maker fill, Risk returns
`makerPostFillVersion` only after paired accounting and both post-fill coverage checks succeed.
Book may copy it only into that exact slot/generation's surviving, non-clipped remainder.
Never refresh another resting order or a pruned/deleted node; current position-version and
market/account-epoch checks remain mandatory before every later fill.

**Selected sidecar and width contract.** The Risk/Book ABI uses `uint64` account epochs and `uint64` order lot quantities. B's original 256-bit packed slot has only `uint32 accountEpoch`, `uint48 size`, and no market epoch; it does not implement this ABI by itself. Use a dense slot-indexed sidecar carrying the full `uint64 accountOrderEpoch`, `uint64 marketOrderEpoch`, `uint64 reduceVersion`, and future-fee attribution. The original packed epoch field may be a non-authoritative cache only: validity always compares the complete sidecar values. At the book boundary, selected adapter behavior is to enforce `configuredMaxOrderLots <= type(uint48).max` and reject any incoming uint64 size exceeding that configured/packed maximum **before** a checked cast. Widen uint48→uint64 on reads. Never truncate a size or epoch. If the book team later revises packing, the external/internal Risk ABI remains uint64 and the revised range needs explicit tests.

Sidecar identity is protected by the same generation check and is overwritten on slot reuse. Retire a slot before its 24-bit generation wraps; never allow an old public ID to regain validity. Epoch/version exhaustion is also checked and must not silently wrap. Aggregate per-account quantities use wider checked sums because many individually uint64 orders can coexist.

The extra per-account price extrema permit a constant-time conservative margin check without an account-level order scan. On a new bid, raise `maxBidTick`; on a new ask, lower `minAskTick`. Removing an extremal order may leave a pessimistic bound until the reservation epoch is cleared. This can reject an otherwise feasible order but cannot authorize unsafe exposure. Rebuilding tight extrema is optional and requires a bounded, verified account-order enumeration; it is not required by this seam.

## Reservations and both-outcome admission

Let `U = 1000 * Q` in cashQ per winning lot. For a settled account and current reservations define `cEff = cashQ - feeCapQ`:

\[
\bar d_0=\max(0,-(c_{eff}-V^b)),\qquad
\bar d_1=\max(0,-(c_{eff}+Ux-UQ^a+V^a)).
\]

These use both outcomes independently. A bid spends cash and is adverse for NO; an ask sacrifices YES payoff and is adverse for YES. Never use only the account's current long/short direction when checking coverage. The reserve must satisfy both `R0 >= Dbar0 + fundingAllowance` and `R1 >= Dbar1 + fundingAllowance`. At launch 1x or the selected full-backing policy, both order-aware account deficits must be zero. Fees reserve conservatively for every potentially executed lot and per-fill rounding; a fee cap must not assume one fill when the order can fragment across makers.

**Selected baseline margin reservation: adverse marked-fill contributions plus a certified IM envelope.** This replaces a cash/inventory rectangle, which would falsely reject direct leveraged buys from a flat position. Keep the dependence between every fill's cash change and inventory change. Let `mQ = 1000*qWad`, `pBidMaxQ = maxBidTick*Q` and `pAskMinQ = minAskTick*Q`. Then

\[
E_{min}=c+x m_Q
-Q^b\max(P^b_{max,Q}-m_Q,0)
-Q^a\max(m_Q-P^a_{min,Q},0)-feeCap_Q.
\]

For a bid fill of `n` lots at tick `t`, the exact marked-equity change is `n*(mQ-t*Q)`; for an ask it is `n*(t*Q-mQ)`. Every bid tick is at most `maxBidTick`, every ask tick at least `minAskTick`. Summing only adverse possible contributions and granting no favorable unfilled credit proves this `Emin` is a lower bound over all prefixes and bid/ask mixtures. Conservative extrema retained after cancels remain safe; the taker's temporary limit commitment must also update the relevant extremum for its action. No weighted-average limit price is substituted.

The possible signed inventory lies within `xLo=x-Qa`, `xHi=x+Qb`. Define

\[
IM_{upper}=\max\!\left(\operatorname{LongIMUpper}(\max(0,x_{hi})),\operatorname{ShortIMUpper}(\max(0,-x_{lo}))\right).
\]

Require `Emin >= IMupper`, plus all exact terminal-deficit, account-cap and market-coverage conditions. **The selected Risk kernel must make each side's upper-envelope helper nondecreasing in size.** Closeout horizon is nondecreasing; directional adverse hazard and the resulting shock multiplier use monotone upper bounds over the horizon; empirical volatility calibration supplies a nondecreasing horizon upper envelope, not noisy raw bins that can dip; any conditional-drift term likewise uses a validated nonnegative monotone upper envelope. Closeout/impact terms and cap parameters obey nonnegative/domain guards. Products, sums and min/max of the resulting nonnegative nondecreasing size functions remain nondecreasing. The full-backing switch is upward because pre-switch IM is already capped by full worst loss. Under these constraints, evaluating the validated per-sign IM upper kernel at that sign's maximum reachable size bounds every interior size, including sign-changing orders.

If a calibration/model variant cannot prove that property, it must provide a generic certified monotone envelope; the safe fallback is full worst-case-loss margin at the maximum sign-specific size. It must not silently use an unsupported endpoint approximation. Use checked arithmetic/outward rounding and still recheck every actual filled account. The exact full-backing shortcut also remains valid: if both order-aware terminal deficits including fee caps are zero, every fill mixture has `E>=W>=IM`. This shortcut is optional optimization of a proved predicate, not a replacement for leveraged admission.

**Direct-leverage regression is mandatory.** With no earlier orders, a flat account bidding exactly at the mark has no adverse marked-fill term. Its `Emin` equals its deposited collateral minus fees; spending trade cash does not independently destroy marked equity. Therefore reserve-backed leverage can pass when the chosen IM kernel and reserve permit it. The old `c-Vb` rectangle is prohibited as the baseline because it would turn this state into negative margin equity even though the bought inventory offsets the cash spending.

An order in `REDUCE_ONLY` must carry `reduceOnly=true`. At admission record `positionVersion`; the side must oppose current position and requested executable quantity cannot exceed current absolute position. Admission may reserve the clipped quantity. A marketable order may close only part of that quantity. An unrelated position change can later invalidate the commitment: validity must be checked again at each fill.

The normal-order rule is **not** “an old account below IM can never transact.” Existing exposure can fall below IM as time and mark change. The canonical risk module distinguishes fresh exposure from permitted voluntary/forced reductions. Any reduction exception must be explicit in `AdmissionMode`, preserve both-outcome coverage and obey the chosen no-worse-risk rule. User-facing requests cannot select `FORCED_REDUCTION`; only the liquidation/compression module can issue that capability.

## Internal hook contract

```solidity
// Risk-owned market/account preparation.
function _riskBeginAction() internal returns (RiskSnapshot memory snap);
function _riskTouchAccount(uint32 trader, RiskSnapshot memory snap) internal;

// Risk-owned ephemeral taker commitment. No book order is created here.
function _riskPrepareTaker(
    OrderRequest memory req,
    RiskSnapshot memory snap,
    AdmissionMode mode
) internal returns (TakerPermit memory permit, RejectCode rejection);

// Risk-owned paired economic fill. Expected failure is returned, not caught.
function _riskTryMatchedFill(
    RiskSnapshot memory snap,
    TakerPermit memory permit,
    OrderView memory maker,
    uint64 proposedLots
) internal returns (StepResult memory result);

// Book calls only when adding a physically resting order.
// A LIMIT remainder converts an existing permit; it is not reserved twice.
function _riskAdmitRest(
    RiskSnapshot memory snap,
    uint32 owner,
    Side side,
    uint16 tick,
    uint64 lots,
    uint32 expiryBlock,
    bool reduceOnly
) internal returns (EpochTag memory tag, uint64 reduceVersion, uint256 feeCapQ);

function _riskConvertPermitToRest(
    RiskSnapshot memory snap,
    TakerPermit memory permit,
    uint64 lotsToRest,
    uint32 expiryBlock
) internal returns (EpochTag memory tag, uint64 reduceVersion, uint256 feeCapQ);

// Used for cancellation/expiry/pruning/amend-down, never again after fill debit.
function _riskOnUnrest(
    RiskSnapshot memory snap,
    uint32 owner,
    EpochTag memory admittedAt,
    Side side,
    uint16 tick,
    uint64 removedLots,
    uint256 releasedFeeCapQ
) internal;

function _riskCancelAll(uint32 trader) internal returns (EpochTag memory newTag);
function _riskFinishTaker(
    RiskSnapshot memory snap,
    TakerPermit memory permit
) internal;
```

`TakerPermit` is a transaction-local memory object deliberately shared across internal calls; the canonical implementation must make its mutation semantics explicit. The Risk module updates its remaining quantity/fee reservation when a fill executes or a remainder converts. If code structure copies the object instead, return the updated permit from every mutating hook and reassign it. Never rely on a silent copy carrying updated quantities.

### `_riskBeginAction`

Precondition: entrypoint authorization, chain/market selection and syntactic request checks have succeeded; no matching is in progress. Derive stage from timestamp/stored policy, advance any order-invalidating market epoch, accrue previous funding rate to the bounded authorized time, consume the funding budget using the OI applicable to each accrual step, and freeze the premium tariff and segment cutoff according to the canonical premium policy. Funding is fixed-sign within each hourly epoch. If an epoch boundary has been reached, freeze the old epoch and enter the bounded rollover sweep; do not start a new trading action until its required sweep is complete. Return a frozen risk snapshot. The snapshot freezes prices, stages, parameter versions and funding index and premium cutoff for this transaction only. It does **not** freeze mutable OI, reserve cash, account sums, fee totals or deficit bounds: those update after every fill.

A staged market epoch bump invalidates orders logically immediately. It does not globally visit or erase account sums. Stale reservations still included in `Dbar` remain conservative until touched accounts release them.

### `_riskTouchAccount`

Settle all owed funding and premium on the account's **old position and old deficit basis**, using the canonical premium/funding ordering. The locked premium module integrates exact deficit segments within the fixed-sign funding epoch, excluding already-charged current-epoch premiums from the premium principal; the book must not substitute `currentDeficit × elapsedTime`. Adding new deficit renews that account's 4x loading window for six hours under the canonical renewal rule. A maker cannot receive new inventory and then have earlier funding charged against that new size. Refresh account checkpoints and its contribution to current coverage. If stored reservation tag differs from current market/account epoch, clear those old sums and replace the account contribution once. This is an internal account touch, not a liquidation or bad-debt cash payment.

The canonical accrual module provides exact segment integration and funding-bound reconciliation. The book hook must not create an independent approximation. On account touch remove exactly that account's attributable positive funding payment from the cushion. Preserve the remaining cushion for other accounts; never release it by guessing. A complete fixed-index sweep must reconcile it to zero. The bounded sweep visits the frozen account registry at the frozen epoch index, settles each account once for that sweep generation, clears invalid reservations, rebuilds exact contributions, and authorizes the new epoch only on completion.

Postcondition: account accrual is current at snapshot indices, current-epoch reservation sums are internally consistent, and market coverage still holds. Premium charges post to reserve at the same time; funding rounding posts only permitted dust to reserve.

### `_riskPrepareTaker`

Touch taker first. Validate stage, order permission, expiry, listing price band, size limits and maxSteps against configured bounds. Determine a conservative **safe prefix** at the worst executable limit price, including existing resting orders, both terminal deficits, initial margin, fees, reserve capacity and per-account deficit caps. Reserve this temporary commitment immediately in the taker's contribution to `Dbar` before entering the book.

The admitted quantity need not be the mathematically largest possible quantity. It must be safe for every executable prefix from zero through the cap. Do not use an unproved binary search over a sign-changing inventory interval: direction-specific caps and margin/hazard transitions can destroy naïve monotonicity. Split at position-zero and any other discrete risk boundaries, use the risk engine's proven envelope, or choose a conservative smaller cap. Selected v1 uses a bounded halving search of at most64 steps: test the full requested prefix with the certified envelope; if it fails, halve the candidate until it passes or reaches zero. Every returned cap has an all-prefix proof; maximal fill size is not promised. Split at position-zero before applying a reduction-only branch. This deterministic safe cap avoids relying on unproved predicate monotonicity. Tests compare the result to an exact small-state enumeration. A minimum-order-size cap can return zero-effect/no-admission with a reason.

The permit is not a real order: it has no FIFO priority, generation or account order-epoch membership. It is released at transaction end and cannot survive in storage as an executable commitment. Persistent resting sums and permit sums are distinct so cancel-all, self-trade cleanup or stage invalidation cannot accidentally release the taker's temporary reserve.

### `_riskTryMatchedFill`

Precondition: book supplied the current head or otherwise next FIFO candidate, valid exact identity, opposite side, and price within permit limit. Proposed quantity is at most maker remaining and permit remaining. Stage/snapshot versions match the active action. No oracle/rate/parameter mutation can occur mid-loop.

1. Settle touched maker funding/premium before testing or filling it. Taker is already current at the same indices; repeat touch is a no-op.
2. Revalidate maker's **remaining current-epoch commitments** at current mark, hazards, margin and fee policy. Prior admission is not sufficient after time/price changes. If maker is below MM, or its normal commitments no longer meet current IM, logically cancel its account's resting commitments (epoch bump + contribution replacement), then return `PRUNE_MAKER`. No liquidation cash transfer happens here. The separate risk worker may act later.
3. Check reduce-only version, sign and remaining reducible size for each flagged side. Clip the fill to the minimum valid quantity. If a maker has no reducible quantity, return `PRUNE_MAKER`; if the taker has none, return `STOP_TAKER`. A reduce-only fill can reach zero but cannot cross it.
4. Compute candidate account deltas at **maker tick**, exact notional, fees, reservation debits, position-version changes and affected reserve/fee ledgers in memory. Preflight all applicable postconditions. If the taker lacks capacity, return `STOP_TAKER`; do not cancel an otherwise valid maker just because this taker cannot trade. If there is an account-specific maker failure, return `PRUNE_MAKER` and invalidate as specified. Global coverage failure after a proven permit is unexpected; either the canonical risk engine explicitly returns a conservative `STOP_TAKER` before mutation, or assertions identify an implementation defect. Never silently force the trade.
5. Commit the two ledger deltas together, consume maker's reservation and the taker's temporary commitment, credit fees/premium/dust as defined, update OI and position versions, and replace both accounts' cached deficit contributions using current mutable aggregates. Compute reserve outcome values from the actual reserve account. Recheck **both** coverage inequalities.
6. Return the executed size and whether maker remainder must be cancelled. Book then decrements physical quantity/level totals or unlinks it. An executed quantity is already unreserved by Risk; book must not call `_riskOnUnrest` on that same quantity again. If a reduce-only remainder is invalidated after reaching zero, only that *unfilled* remainder passes through `_riskOnUnrest`.

The paired ledger equations are `dx = +lots` for buy and `−lots` for sell, `dcQ = −dx * tick * Q`. Maker/taker signed position changes sum to zero. Trader cash changes plus reserve/fee postings sum to zero. The transaction does not temporarily collect only one side as an observable state.

### `_riskOnUnrest`

First touch/synchronize the owner at the action snapshot, or assert that the owner is already settled there. Then determine whether the supplied epoch still owns a current reservation. The `tick` argument is mandatory: removing `lots` must remove exactly `lots * tick * Q` from the corresponding value sum. A size-only callback cannot maintain `Vb/Va`. Release the precise attributed future-fee cap, not the realized fee already charged on prior fills. Current-epoch calls update quantities/values/fees and replace cached deficits. An old epoch tag is a **no-op for current sums** because that epoch's reservation was already logically cleared. This avoids delayed physical pruning subtracting reservations from a new order epoch. Underflow, wrong side/tick attribution or excess release is an assertion failure and reverts; it is not papered over with saturating subtraction.

### `_riskCancelAll`

At a top-level authorized cancel-all, begin/synchronize the action and touch the account first. Inside an existing match action, reuse its frozen snapshot and the already-settled account; do not begin a nested market accrual action. Bump `accountOrderEpoch`, clear its persistent resting sums and fee caps, and replace its contribution once. The book keeps stale nodes until bounded traversal or explicit cancellation removes them. New orders record the new epoch. A concurrent filled/cancelled old generation is zero-effect. A pending taker permit is separate and is not cleared. Liquidation may invoke the same invalidation primitive under its own capability before taking over/reducing the account.

### `_riskFinishTaker`

Release unfilled permit commitment unless converted to an eligible resting order; validate final order-aware account/risk state and both market coverage inequalities; ensure permit residual is zero. Do not update the funding rate here: the rate and its sign are fixed for the active hourly epoch; only completed rollover authorizes the next epoch rate. Final state feeds that later authorization, not an intra-epoch rate mutation. Unexpected failure reverts atomically. This final check supplements, rather than replaces, per-fill checks.

## Market/account epoch and reduce-only correctness

**Market invalidation.** Increment `marketOrderEpoch` whenever a stage change or policy change explicitly invalidates resting orders. Every accounting rollover invalidates the market order epoch. Monitor hazard raises immediately impose reduce-only; their new tariff/profile takes effect at the next completed epoch. Makers are still re-admitted at each fill under current prices. Avoid bumping an epoch for every account touch. Risk epoch and order epoch have distinct meanings.

**Epoch sweep gate.** The market has an independent synchronization state (`READY`, `ROLLOVER_SWEEP`, `FLOOR_SWEEP`, `HALT_SWEEP`). Stage alone is insufficient. `placeOrder`, match, new rest, amend-up, reserve withdrawal and trader collateral release require the relevant `READY` state. During a rollover/floor sweep, trading and market allocation/release pause. Free-vault deposits, bounded sweep progress and physical pruning of already-invalid orders remain available. No account cash/top-up mutation occurs inside a frozen sweep. Do not interpret “no new exposure” as permission for a public reduce-only matcher to mutate the account registry or positions while the fixed-index sweep is rebuilding totals. Floor-sweep takeovers are performed only by the sweep routine after synchronizing its current account; no ordinary liquidation/book call mutates a frozen sweep. Halt can override the sweep using the frozen-cutoff rules. A keeper failure leaves the gate closed and old-epoch funding stopped rather than silently starting a new epoch.

**Final-day gates.** Apply B's selected clock: full-backing admission grace begins T−12h30m; funding freezes at T−12h; reduce-only begins T−1h; halt occurs at T or an authorized earlier resolution proposal. At the floor, activate the full-backing admission predicate immediately, invalidate incompatible orders and enter `FLOOR_SWEEP` if materialization is needed. Do not claim all historical trader balances changed automatically when time crossed the boundary. Risk's bounded sweep and takeover process establishes the intended backed state while per-outcome reserve coverage remains the safety invariant. Trading reopens only under the completed-floor conditions. Early halt cancels/invalidate orders and uses the halt/snapshot sweep; it does not wait for price-based liquidation or pretend remaining deficits disappeared. No book fill is allowed in `HALTED` or `CLAIMS_READY`.

**Expiry.** Proposed semantics: `expiryBlock=0` means no expiry; nonzero orders are executable while `block.number <= expiryBlock`, and are stale when greater. This inclusive good-til-block convention is a new integration choice and must match UI, book and tests. Expired commitments can remain conservatively reserved until bounded pruning or the owner's explicit cancellation; an expired order can never execute just because the account's sums still include it.

**Position version.** Increment `positionVersion` on every sign transition, including nonzero→zero and zero→nonzero. A reduce-only order captures the version at admission. If inventory goes long→flat→short→long, the old sell reduce-only order cannot unexpectedly revive on the new long position. Flags and current sign alone would miss this lifecycle. Normal orders do not depend on positionVersion; they still face readmission. Reduce-only reservations whose version became stale remain conservative until release; they do not justify new inventory.

**Partial fills.** Suppose a maker sells reduce-only against a long 10-lot position and rests 10 lots. A prior unrelated trade reduces position to 3. On touch, eligible maker size is at most 3; fill 3, reach zero, increment version and cancel the other 7. If the position had already flipped short, execute zero. The cancellation releases only the 7 unfilled lots; the 3 were unreserved in paired settlement. Taker reduce-only follows the same rule.

## Transaction pseudocode

```text
placeOrder(request):
    authorize request.trader; enforce engine reentrancy guard
    validate raw enum/range/size/maxSteps inputs
    snap = riskBeginAction()
    if economic synchronization is not READY: return SweepRequired(no admission)
    (permit, reject) = riskPrepareTaker(request, snap, NORMAL_OR_REDUCTION)
    if permit.remaining == 0: return NoAdmission(reject)

    if request.kind == POST_ONLY and bookWouldCross(request.limit):
        riskFinishTaker(snap, permit)  // releases permit
        return PostOnlySkipped        // batch-safe zero effect except lawful accrual

    steps = 0
    while permit.remaining > 0 and steps < request.maxSteps:
        maker = bookNextOppositeAtOrBetterThan(request.limit)
        if none: break
        steps += 1                   // every examined node, not only successful fills

        if stale generation/epoch/expiry/reduceVersion:
            bookRemoveWithRiskUnrest(maker, specificReason)
            continue
        if maker.owner == request.trader:
            bookRemoveWithRiskUnrest(maker, SELF_TRADE)
            continue

        result = riskTryMatchedFill(snap, permit, maker,
                    min(maker.remaining, permit.remaining))
        if result.status == PRUNE_MAKER:
            bookRemoveWithRiskUnrest(maker, FAILED_READMISSION)
            continue
        if result.status == STOP_TAKER:
            break

        bookApplyFillWithoutDuplicateUnrest(maker, result.filledLots)
        if result.removeMakerRemainder and maker still has unfilled lots:
            bookRemoveWithRiskUnrest(unfilled remainder, REDUCE_ONLY_EXHAUSTED)
        emit canonical Fill after BOTH risk and topology changes

    if request.kind == LIMIT and permit.remaining >= minimumRestSize:
        if not bookWouldCross(request.limit):
            metadata = riskConvertPermitToRest(snap, permit, eligibleRemaining, expiry)
            bookAppendNewOrder(metadata)   // same atomic transaction
        else:
            emit OrderRemainderDropped(CROSSED_REMAINDER)
    // IOC and crossed/exhausted remainder are never rested.
    riskFinishTaker(snap, permit)
    assert both coverage sides, reservation consistency for touched parties
    return execution summary
```

`POST_ONLY` needs no traversal. Its crossing check is performed against book state after any requested batch cancellations. A batch places a bounded number of actions and caps total examined nodes; per-order caps alone are insufficient if an unbounded batch is accepted. A post-only skip may still materialize elapsed funding/premium just like any lawful account touch; do not describe it as zero storage changes.

The source's `maxFills` can be retained as an external field name for compatibility, but its documented meaning must be **maximum examined maker steps**. Expired nodes, stale epochs, self orders and failed readmissions all consume one. The policy supplies the actual numerical cap; this interface does not substitute D's eight-step recommendation for B's measured setting. Cap requested lots and batch action count before multiplication or traversal, and use checked conversions for narrower book fields.

## Failure and rollback matrix

| Condition | Response | Economic/topology effects allowed to persist |
|---|---|---|
| Unauthorized caller, malformed tick/size/enum, overconfigured step cap | Revert entrypoint | None |
| Old-generation cancel, already-dead order cancel | Return not-cancelled | No order/economic mutation from that cancel; prior lawful batch actions may persist |
| Current order expired/stale/self-trading | Prune and consume step | Release only still-live reservation; topology/event update |
| Maker fails current risk admission | Invalidate maker commitments, prune candidate, consume step | Settled accrued funding/premium plus safe reservation release |
| Taker cap is zero | Return explicit no-admission | Lawful synchronization/accrual can persist; no trade |
| Taker cannot accept candidate | Stop traversal | Earlier valid fills remain; valid maker retained |
| Reduce-only loses valid sign/version | Maker prune or taker stop | No sign-crossing trade; unfilled reservations released correctly |
| Crossed LIMIT remainder at step cap | Drop remainder | Earlier fills remain; no crossed book |
| Invariant/overflow/underflow/incorrect generation bookkeeping after supposed valid mutation | Revert whole transaction | No earlier fill, cancellation or log survives |
| Requested all-or-none option, if separately implemented later | Explicit request-level semantics | Not inferred by this seam; do not simulate with per-fill external catch/revert |

Internal Solidity calls cannot isolate a revert into a “skip” without redesign. Therefore expected skips are represented by **preflight return codes before economic fill mutation**. Do not introduce external self-calls/try-catch into matching to recover failed risk checks. An unexpectedly reverting risk assertion intentionally aborts the transaction.

## Required book records and events

The book team must expose a lossless internal `OrderView`, even if underlying storage is packed. It must be possible to determine owner, identity/generation, side, limit tick, remaining lots, expiry, market epoch, account epoch, reduce-only version and remaining fee reservation attribution from current state. No event-only field may be needed to enforce on-chain safety.

Proposed event payloads (market identity may be implicit for a per-market engine):

```solidity
event OrderPlaced(
    uint32 indexed trader, uint32 indexed slot, uint24 generation,
    Side side, uint16 tick, uint64 lots, uint32 expiryBlock,
    uint64 marketEpoch, uint64 accountEpoch,
    bool reduceOnly, uint64 reduceVersion
);
event OrderRemoved(
    uint32 indexed trader, uint32 indexed slot, uint24 generation,
    uint16 tick, uint64 removedLots, RemovalReason reason
);
event OrderAmendedDown(
    uint32 indexed trader, uint32 indexed slot, uint24 generation,
    uint64 oldLots, uint64 newLots
);
event OrdersInvalidated(
    uint32 indexed trader, uint64 marketEpoch,
    uint64 oldAccountEpoch, uint64 newAccountEpoch, RemovalReason reason
);
event MarketOrdersInvalidated(uint64 oldEpoch, uint64 newEpoch, uint64 riskVersion);
event Fill(
    uint32 indexed maker, uint32 indexed taker,
    uint32 makerSlot, uint24 makerGeneration,
    Side takerSide, uint16 tick, uint64 lots,
    uint256 makerFeeQ, uint256 takerFeeQ
);
event OrderRemainderDropped(uint32 indexed trader, uint64 lots, RemovalReason reason);
```

One canonical `Fill` is emitted only after paired clearing and book size updates succeed. The book/engine orchestrator owns this emission; Risk must not emit a duplicate fill for its two account legs. Risk may emit separate account/coverage deltas carrying consistent transaction identity. A full fill and an order removal event must be documented so the indexer does not subtract filled quantity twice. `OrdersInvalidated` permits indexers to hide all old orders immediately without waiting for lazy physical pruning.

Size reduction at unchanged price/permission/expiry retains FIFO priority and calls `_riskOnUnrest` for only the size delta. New price, increased size, later expiry or widened permissions is cancel-and-replace with fresh admission/new identity and new priority. A shorter expiry is safe only under an explicitly supported amend rule; no broadened permission is slipped into the size-only fast path.

## Mock integration acceptance tests

Risk developers need a tiny deterministic mock book: ordered lists of supplied `OrderView` fixtures, bounded next-maker lookup, size decrease/removal, and captured events. It is not the production bitmap/FIFO implementation. The book team supplies a mock Risk implementation returning scripted step results to verify traversal independently. The shared integration fixture then combines real risk with the mock book.

| Test | Fixture/action | Required result |
|---|---|---|
| Exact integer bilateral trade | Buy 17 lots at tick 613 against matching maker | Notional 10,421×Q; Δpositions ±17; pre-fee ΔcashQ ∓10,421×Q; both terminal values checked |
| Both-outcome admission | Fully backed long 1 claim/cash0 posts ask2.3 claims at .55 | Reject: final YES value −35,000×Q; checking only current NO deficit is insufficient |
| Value release requires tick | Rest bids 7 lots@400 and 11@600; cancel first | Qb=11, Vb=6,600×Q; not an average-price approximation |
| Current epoch cancel-all | Two rests→cancel-all→new rest→lazy prune old nodes | New reservation totals unchanged by old-node pruning; deficit release happens once |
| Stage epoch sidecar | Change from Trading to stage invalidating orders without visiting accounts | Old packed accountEpoch alone cannot authorize fill; market sidecar blocks it |
| Expiry boundary | expiryBlock=K, matches at K and K+1 | Executable at K, pruned at K+1; both consume correct steps |
| Recycled generation | Cancel stale generation after slot reuse | New live order and its sums untouched |
| Maker funding before fill | Maker owes funding on old 10-lot position, then fills 5 lots | Charge applies to old10 before new15; not retroactive funding on15 |
| Maker premium before admission | Accrued premium reduces maker below IM | Account touch/credit reserve, invalidate commitments, skip; no fill, no pre-settlement bad-debt cash payment |
| Price-only readmission | Same market epoch, mark changes enough to violate maker IM | Maker rechecked and removed despite valid stored epoch |
| Partial reduce-only | Reduce-only sell10; position independently shrinks long 10→long 3 | Fill at most3, remove7, flat without short flip; release quantities exactly once |
| Reduce-only revival | long→flat→short→flat→long between admission and encounter | Old order invalid due positionVersion even though current sign again matches |
| Taker reserve prefix | Requested taker crosses through zero into opposite-side cap | Permit covers every accepted prefix or conservatively clips before unsafe branch |
| Worst-limit improvement | Buy permit at 650 executes610 then620 | Better fills cannot consume more notional than reserved limit; fees remain within cap |
| Both reserve outcomes | Construct fill improving NO slack but worsening YES slack | Reject/stop before mutation if YES coverage fails |
| Mutable aggregates | Two maker fills individually fit initial reserve but together do not | Second uses updated first-fill totals; cannot read frozen initial coverage |
| Dirty maker queue | Expired + self + stale + failed readmission, maxSteps4 | Four examinations, zero fifth-node visit, bounded gas path |
| No liquidity at limit | Permit reserved; no acceptable maker; IOC | Release permit; no persistent commitment remains |
| Crossed remainder | Budget exhausted while next maker still crosses LIMIT | Drop remainder; never create bestBid≥bestAsk |
| Expected stop | First fill valid, second cannot fit taker | First persists, valid second maker remains, permit safely released |
| Unexpected assertion | Force accounting mismatch on second fill | Whole transaction reverts, including first fill and all logs |
| Fragmented fees | One requested order split over many maker fills | Reserved fee cap covers per-fill rounding and does not understate total fees |
| Interior IM hump | Synthetic risk formula whose interior-size IM exceeds both endpoint values | Envelope catches it; endpoint-only admission rejected by reference fixture |
| Exactly-backed 1x bid | Flat account deposits exact worst-limit cash plus fee cap | Proved order-aware predicate admits it; no independent cash/inventory rectangle is used |
| Direct 5x entry | Validated scheduled fixture below: flat account buys 1000 claims at mark 0.60 with 120 USDC and funded reserve | Admission and bilateral fill succeed; long NO deficit480 USDC is covered, displayed leverage5x |
| Nonmonotone empirical bins | Raw sigma estimate dips as h grows | Calibration converts to a nondecreasing conservative horizon envelope or rejects deployment |
| Packed size range | uint64 request exceeds configuredMaxOrderLots≤uint48.max | Reject before downcast; no truncated order or mismatched reservation |
| Full epoch width | account epoch exceeds uint32.max while sidecar uint64 is valid | Complete64bit comparison controls validity; packed low bits cannot revive stale order |
| Rollover gate | Cross hour boundary with unfinished frozen-index account sweep | No match/new rest/withdraw; funding stops at old allowance/end; free-vault deposits, stale-order pruning and sweep progress remain usable |
| Floor materialization | Pass T−12h while some accounts remain leveraged | Funding frozen, book gated; reserve coverage persists; global 1x success not reported before sweep completion |
| Exact premium principal | Several touches within fixed-sign epoch after earlier premium charge | Repeated touch matches exact segment integral; prior premium not charged premium again |
| New-deficit loading | An executed fill adds deficit inside an existing account | Six-hour 4x window renewal follows canonical account rule before later accrual |
| No external calls | Instrument all matching branch paths | No token transfer, oracle call, account callback or external self-call occurs |
| Same-block accrual | Multiple fills/touches at same economic timestamp | No duplicated funding/premium accrual |
| Unrest after full fill | Full fill then physical free-list recycling | Executed lots are not unreserved a second time |

Acceptance requires the mock integration traces preserve allocation/cash conservation, zero-sum position including reserve, both coverage inequalities, order-reservation sums, correct epochs, and no duplicate fill/claim semantics after every transaction. Integer tests use exact cashQ values and separately verify custody-atom rounding; fuzz/reference tests include sign changes, pending accrual, fees and stale reservations. Sweep-time market top-ups are prohibited; stale-order physical cancellation is a current-reservation no-op. A visited account cannot be credited twice and an unvisited account cannot be omitted. Numerical risk calibration is a separate gate owned by the risk engine, not a reason for the book to choose new economics.


## Executable direct 5x entry fixture

This is a **test-only validated-template configuration** proving the selected seam permits one-way leverage. It does not bypass production leverage gates or claim the placeholder parameters are calibrated.

- `qWad = indexWad = 0.60*Q`, fill/limit tick 600; 1,000 claims =1,000,000 lots; zero trading fee; no elapsed premium/funding; live stage; no old orders or stale epochs.
- Scheduled template cap 5; time remaining29 days; `h0=5min`, absorption1000 claims/min gives `h=6min`; both hazards0.01%/day; `epsilon=.01`, `gamma=1.5`, `s=.005`, `lambda=1e-6/claim`. Use monotone upper-envelope kernel. The linear hazard bound is 4.1666666667e-7, `sigma=sqrt(.24*360/2505600)=.005872202195`; the Cantelli multiplier is about 9.95008. Thus MM is about 63.929058 USDC and gammaMM about 95.893587 USDC; the cap branch makes IM=600/5=120 USDC.
- Taker is initially flat with `cashQ=120_000_000*Q`. Temporary bid reserves `Vb=600_000_000*Q`; `maxBidTick=600`, so the marked adverse-fill deduction is zero. `Emin=120_000_000*Q`, and the long 1000 claim IM envelope is 120 USDC. The old rectangle would wrongly show−480 USDC; the selected rule passes.
- Maker is flat, deposits 400 USDC and rests an ask for 1000 claims at 600. Its fully-backed short-side commitment passes both outcome checks. The reserve starts with 100,000 USDC cash, no position, funding allowance0; per-account deficit cap 2% gives2,000 USDC, above the taker's480 USDC worst deficit.
- After fill: taker `x=+1_000_000lots`, `cashQ=−480_000_000*Q`, mark equity120 USDC, outcome valuesNO=−480/YES=520 USDC, leverage600/120=5. Maker `x=−1_000_000lots`, `cashQ=1_000_000_000*Q`, equity400 USDC, outcomesNO=1000/YES=0 USDC. Trader cash still totals520 USDC, positions net tozero; reserve has enough for NO480 and YES0 separately. Every stored and emitted amount uses exact cashQ.
- Test the entire path: admission, temporary coverage reservation, maker touch/readmission, paired fill, book debit, permit release, and final invariant check. Assert the request is not merely admitted then stopped before fill. Run smaller partial-fill prefixes and two-maker fragmentation too. A separate fixture with reserve below required NO cover must fail, despite the same valid margin calculation.

**Fixture calculation checked during document preparation:** numerical enumeration of all 1,000,000 one-lot prefixes found maximum IM120 USDC; exact integer ledger arithmetic at tick 600 found NO deficit no greater than 480 USDC and YES deficit zero for every prefix. This validates the worked fixture, not the yet-to-be-built production book or a general monotonicity proof. The integration tests above remain required.


# Oracle, halt and settlement integration contract

**Scope.** This is the interface the two Risk & Clearing developers implement and hand to the external oracle team. The external team owns evidence, AI models, human review, CRE, UMA assertions, disputes, retries, bonds, and its resolution state machine. The engine owns positions, USDC cash, reserve coverage, funding/premium accrual, halt snapshots, INVALID-price storage, payout preparation, and claims. No engine function judges evidence, checks model confidence, calls UMA, funds an oracle bond, or interprets an assertion ID. These boundaries implement Build §§10, 14, 16 and Oracle §§1–2, 7, 9. The choices explicitly marked **selected integration rule** fill gaps between those sources; they are not claims that the original PDFs already specify them.

## Authentication and the minimal API

Each MarketEngine instance binds once to a `marketId`, `MarketRegistry`, and the canonical `ResolutionOracle` address during initialization. The oracle may call the engine directly; UMA and `UmaAdapter` may never call engine economic methods. The external team's adapter authenticates UMA/relay results and forwards them to ResolutionOracle; ResolutionOracle authenticates that adapter and the current assertion ID before deciding finality. This resolves the source's contradictory OOv3-versus-adapter callback sender at the seam: **engine trusts ResolutionOracle only; oracle implementation trusts its pinned adapter only**. A production adapter replacement follows the oracle team's governance rules and does not add an engine privilege or change a completed outcome. [O §§7.1–7.4, 9.1]

Use the source-compatible entry points below for a per-market engine. Extra data belongs in query/event responses rather than new oracle-controlled price arguments.

```solidity
interface IResolutionEngine {
    // only ResolutionOracle: idempotently materialize the economic halt.
    function halt() external returns (HaltView memory snapshot);

    // only ResolutionOracle: Y is exactly 0 (NO) or 1 (YES).
    // Accept immutable finality; does not loop accounts or transfer USDC.
    function settle(uint8 Y) external returns (bool newlyAccepted);

    // only ResolutionOracle: request settlement using the listed INVALID rule.
    // Oracle supplies no price. Price may still be pending.
    function settleInvalid() external returns (bool newlyAccepted);

    function getHaltSnapshot() external view returns (HaltView memory);
    function getSettlementStatus() external view returns (SettlementView memory);
}

struct HaltView {
    bool halted;
    uint64 economicHaltAt;
    uint64 haltRecordedAt;
    uint64 frozenAccountCount;
    uint64 frozenBookEpoch;
    uint256 oiHaltLots;
    int256 fundingIndexAtHalt;
    uint64 accountingEpochAtHalt;
    uint64 accrualCutoff;
    bytes32 premiumTariffHash;
    bytes32 snapshotId;
}

enum FinalOutcome { UNSET, NO, YES, INVALID }
enum ClearingPhase { LIVE, HALTED, PREPARING, READY, COMPLETE }
```

`FinalOutcome` is an **engine-local** enum, deliberately separate from the oracle source enum `{NONE, YES, NO, INVALID}`. Do not ABI-cast between them. Oracle outcome YES maps to `settle(1)`; NO maps to `settle(0)`; INVALID and Voided map to `settleInvalid()`. `settle(2)` and all other values revert; neither 1,000 ticks nor `1e18` are valid Y arguments. An unauthorized caller reverts even for an otherwise harmless duplicate.

`SettlementView` exposes at least `phase`, `halted`, immutable `finalOutcome`, `oracleFinalityAccepted`, `invalidPriceReady`, `settlementPriceE18`, `snapshotId`, preparation cursor/count, aggregate payout/deficit totals, `claimsEnabled`, and accounting completion status. The UI must use `claimsEnabled`, never oracle state alone, to enable payouts.

The interfaces do not permit the oracle to choose cash, margin, a mark, fees, funding, premium, account list, or INVALID price. `settle*` does not call an untrusted callback. All economic token calls use the engine's existing nonreentrant USDC transfer policy.

## Units and boundary encoding

| Quantity | Encoding / meaning |
|---|---|
| Position | Signed integer lots; one lot = 0.001 claim |
| Halt OI | Unsigned lots, one-sided; sum of positive positions including the reserve account = absolute sum of negative positions |
| Internal cash / raw payout / deficit | Signed cashQ or unsigned deficitQ; external final claims use integer USDC atoms |
| One lot's YES payoff | Exactly 1,000 USDC atoms |
| Binary oracle Y | Integer 0 or 1 only |
| INVALID price | Integer `pE18` in `[0, 10^18]`; endpoints are allowed for settlement even though order ticks are 1–999 |
| Time | `uint64` Unix seconds, UTC; durations in seconds |
| Funding/premium tariff/segment cutoffs | Engine's existing exact fixed-point index types; checkpoint values are copied without rescaling at this seam |

For a frozen signed position `xLots` and `cashQAtHalt`, raw equityQ is `cashQAtHalt + xLots*1000*Q*Y` for binary Y and `cashQAtHalt + xLots*1000*pWad` for INVALID. Floor the positive result divided by Q exactly once to obtain claim atoms. Never round a negative cash balance toward zero before computing equity; carry full Q through preparation. Use checked wide signed products and retain source position/cash for reconciliation.

**Selected integration rule:** adapter code converts the oracle's bond exposure from halt lots explicitly: one full claim is 1,000 lots and one dollar is 1,000,000 atoms, so `OI exposure atoms = oiHaltLots * 1000`. The risk engine reports `oiHaltLots`; it does not calculate or transfer oracle bonds. This avoids treating lots, claims and USDC as interchangeable integers.

## Separate clocks and one immutable economic halt

There are four distinct timestamps and they must not be overloaded:

1. `scheduledT`: immutable listing time used for stage changes and the INVALID TWAP window.
2. `economicHaltAt`: when trading permanently stops. For a scheduled market it is T, even if the first keeper transaction arrives later. For an accepted early proposal it is that proposal's halt transaction time, before T.
3. `accrualCutoff`: min(economicHaltAt, activeEpoch.end), additionally respecting any already-frozen rollover cutoff; funding has its earlier budget/freshness/floor stop.
4. `haltRecordedAt`: block timestamp of the transaction materializing the engine snapshot; operational telemetry only.

The external oracle's liveness, Layer 1 timeout, Layer 2 deadline and void clock remain oracle state. **Selected integration rule:** when the oracle materializes a scheduled halt it copies `economicHaltAt` into its source field `Resolution.haltedAt`, not the late transaction timestamp. For an early halt the two coincide. This prevents delayed keepers from moving economic exposure or extending the advertised 30-day deadline. The oracle must read `oiHaltLots` from the engine's returned/stored snapshot when sizing its bond; it must not re-read live OI after preparation.

Every engine mutation derives the scheduled stage from time. At or after T, it rejects trades, position transfers, liquidations and other economic changes even if `halt()` has not been called. **Selected integration rule:** anyone may call an engine `materializeScheduledHalt()` at/after T using the same internal halt routine; only ResolutionOracle may halt early. This permissionless scheduled action chooses no outcome and grants no oracle discretion. This package selects engine `materializeScheduledHalt()`; implement that route and do not make it contingent on oracle keeper availability.

An early monitor flag only makes trading reduce-only and requests an oracle check. It is not an economic halt. A failed early check restores the allowed trading state according to the monitor policy. Once the oracle actually accepts an early proposal and calls `halt()`, trading never resumes—even if that assertion is rejected and reviewed again. Early YES/NO may finalize before T. Remaining deficits are reserve obligations; neither halt nor settlement waits for account compression or full backing.

## Halt work: constant-size freeze, later bounded account work

The halt routine must not iterate every account or call the external order book. In one atomic transaction it:

1. Derives `economicHaltAt`, then advances global funding and premium accounting to their legal cutoffs using previously authorized rates and funding allowance.
2. Freezes the funding index, premium tariff and segment cutoff. Funding is capped by `min(economicHaltAt, T−12h)` and all earlier allowance/epoch-stop rules. Do not authorize skipped historic funding epochs or rewind an index when a listing is already inside the funding-freeze window. Accrual cutoff is min(economicHaltAt, activeEpoch.end), even when no rollover page has run. Funding also stops at its earlier budget/freshness/floor cutoff. Premiums stop at this accrual cutoff; after the 1x floor, fully backed accounts already owe no deficit premium. Do not charge any waiting time during oracle disputes or payout preparation.
3. Records the immutable active account-list version and `frozenAccountCount`, including the reserve account; positions and frozen input cash/checkpoints become read-only to live mutations. Preparation computes once-only working snapshots from those inputs; it must not call the live-time accrual path. Pending orders are economically invalidated by a market book-epoch bump. The book team may later garbage-collect slots, but must never match an old order.
4. Records `oiHaltLots`, the final global indices, immutable opening reserve/fee ledgers plus a separate working premium-credit/clearing accumulator and other values required to reproduce the frozen cash ledger. At the halt, no more account enrollment, deposits into the market ledger, withdrawals, fills, reserve redemptions, risk liquidations, premium changes, or funding authorization is allowed. Unsolicited USDC transfers do not modify recognized balances.
5. Sets `halted` and derives `snapshotId = keccak256(abi.encode(chainid, engine, marketId, economicHaltAt, accrualCutoff, frozenAccountCount, frozenBookEpoch, frozenAccountingState, oiHaltLots))`. This is a snapshot identifier, **not a Merkle commitment to every account**. Emit `MarketHalted`.

The source says to settle all account funding and premium at halt. **Selected integration rule:** implement its economic meaning with frozen funding index, premium cutoff and lazy per-account materialization in preparation chunks. Each account is evaluated once at the same frozen funding index and premium cutoff on its unchanged old position. Reserve snapshot cash is completed only after summing all pending premium credits and funding postings into its working ledger. This yields the same ledger as an instantaneous full sweep without an unbounded transaction. Normal `touch()` code must not accrue to the current block timestamp during clearing.

A repeated authorized `halt()` returns the same snapshot and does not bump the epoch, change an index, change OI, or reset a deadline. If `settle*` arrives before a halt has been materialized, it invokes this same internal halt routine first. This keeps callback acceptance robust while preserving the correct scheduled/early cutoff.

## INVALID price: the future-window issue and concrete MVP policy

The source rule is an index TWAP on `[T−24h, T]`, fixed at listing. Require T at least 24 hours after listing. If a market halts early, the right-hand part of that window has not happened. A halt-time TWAP, last price, or midpoint is **not** the listed rule. The risk engine must keep these concepts separate:

- Oracle finality can be accepted now.
- The immutable INVALID price may become computable only at/after T.
- Payouts remain disabled until that price and all payout totals are ready.

**Selected rule for new MVP listings:** retain the exact scheduled window; keep the separate index observation recorder running after an early halt; run `captureInvalidPrice()` at or after T, independent of whether the oracle is final. This is a permissionless deterministic capture job, not an oracle judgment and not a risk mark update. It reads an authenticated index accumulator/observation store, computes the full-window time integral divided by 86,400 seconds, requires complete contiguous eligible coverage with no carry across a30-second stale gap under the rule fixed at listing, rounds to `pE18`, and writes the result exactly once with a provenance digest. Calls before T cannot capture. Later observations cannot revise a captured price. Repeating the same capture is harmless.

Index samples after the engine halt serve only the future INVALID window; they cannot restart funding or margin changes. A stopped internal book is not a valid independent fresh index for the remainder of the window. If the pinned index cannot remain independently available, the listing needs a disclosed missing-data policy.

**Concrete missing-data default for new listings, requiring explicit rule text:** set `invalidCaptureGraceSecs = 1 hour` and immutable `invalidFallbackPriceE18 = 5e17`. For a valid full-window TWAP, capture at/after T. If the listed validity/coverage test fails, wait until `T+1h`; then capture the fixed 0.5 fallback with a `FALLBACK_MISSING_INDEX` reason. This is an explicit new design decision, not the PDFs' original unconditional-TWAP rule. Both the rules used by the oracle and the engine's immutable config must state it before listing. **Never apply this fallback to an already-listed unconditional-TWAP market.** For such a legacy market, expose `INVALID_PRICE_BLOCKED` and require governance/product resolution outside this implementation; do not choose a new price or pretend it settled.

To prevent an early Voided deadline preceding any usable INVALID price, **selected integration rule** is a listing horizon gate `T + invalidCaptureGraceSecs <= listedAt + voidSecs`, with `voidSecs = 30 days` in the production profile. Because `haltedAt >= listedAt`, an early halt's void deadline cannot precede the capture/fallback eligibility time. This intentionally excludes new MVP markets listed more than roughly 30 days before T. Supporting a longer horizon requires revisiting the published INVALID rule or void schedule with both teams before listing; it cannot be fixed by moving a live market's deadline.

An early `settleInvalid()` latches `INVALID` and reports price pending. At T/capture completion, the engine continues preparation without another oracle decision. A Voided market follows exactly the same INVALID economics; oracle “Voided” is a reason for INVALID, not a fourth payout price. YES and NO never wait for this TWAP capture because their payoff is already exact. The engine may prepare frozen cash before the price exists, but cannot calculate final INVALID payouts or enable claims prematurely.

## Finality acceptance, bounded preparation, and claims

`settle(Y)` and `settleInvalid()` authenticate first, materialize the halt if necessary, and store an immutable final outcome in constant-size work. They do not settle every account, validate a TWAP availability requirement that could transiently revert the callback, transfer tokens, or enable claims. A duplicate request for the same outcome returns `newlyAccepted=false`; a conflicting outcome after acceptance reverts with `ConflictingFinalOutcome`. Emit `OracleFinalityAccepted` once. `SettlementView` distinguishes accepted finality from completed clearing.

The external oracle may now be Final while the engine is HALTED/PREPARING, and that is expected. **Selected integration rule:** the oracle's Final transition and successful `settle*` acceptance happen in the same transaction on Monad. A genuine engine revert rolls back that oracle transaction; it must never mark Final and silently drop an undelivered engine call. External cross-chain/DVM finality may already exist: the external team stores its authenticated result and retries delivery without changing it. Engine `settle*` must therefore avoid transient causes of rejection such as insufficient batch gas, pending TWAP, keeper backlog, or an unavailable user recipient.

Provide these permissionless, bounded clearing jobs:

1. `prepareSnapshotChunk(maxAccounts)`: progress a monotonic cursor over the frozen list, settle each account at frozen funding index and premium cutoff once, and store immutable `(xLots, cashQAtHalt)`. Aggregate checks include net positions, OI and cash conservation. The job may run before outcome finality and before INVALID price readiness.
2. `preparePayoutChunk(maxAccounts)`: only after finality and the required price exist, compute each trader payout and exact/conservative deficit from its prepared snapshot; accumulate total payout and reserve requirement without transferring USDC. Processing an already-prepared account is a no-op. A fixed outcome/price/snapshot tuple cannot change mid-run.
3. `finishPreparation()`: require both cursors complete, reconcile aggregate funding/premium/rounding amounts and account-list totals, establish reserve contribution and fee segregation, verify recognized allocated assets cover the final payout liability, and enable claims atomically. If baseline liabilities do not fit, enter RECOVERY_REQUIRED with claims disabled. The separately disabled recovery extension uses the earlier exact prelisted rule; oracle finality cannot authorize a haircut.
4. `claim()`: pay exactly the caller's immutable prepared payout once using checks-effects-interactions. A repeated claim returns zero/no effect. A failing transfer does not mark a claim paid. No recipient can block other accounts. Claim order cannot affect amount. Zero-payout accounts can be marked processed without transfers.

The reserve account participates in the frozen position/cash totals, OI and conversion backing checks. It is not an ordinary trader allowed to withdraw a positive payout while simultaneously guaranteeing others' deficits. **Selected integration rule:** segregate trader payout liability and exact protocol/keeper Q fee escrows from reserve residuals; allocate the required reserve contribution during `finishPreparation`, then reserve claims/redemptions remain blocked until all trader liabilities are reserved and engine residual-release conditions are met. Do not double-count reserve cash as both a trader claim and deficit backing.

`READY` means liabilities are fixed and fully allocated, so user claims can begin. `COMPLETE` means all payouts have been claimed or an independently specified, non-confiscatory completion policy applies; no MVP “claim expiration” may discard unclaimed balances. A keeper may retry any preparation job after interruption. On failure, the cursor/totals/account changes revert together; retries never charge funding, premium, payout or reserve contribution twice.

## Optional conversion after the cash path is working

Implement cash clearing first. The source allows optional conversion only when **every account, including the reserve, is fully backed at the halt**. Eligibility is checked against fully prepared halt cash, not stale checkpoints or current prices. To support conversion later without redesign, retain `xLots`, `cashQAtHalt`, `oiHaltLots`, and the same fixed account list and once-only entitlement flags.

**Selected integration rule:** conversion is a market-wide mode selected before any cash claim; mixing independent cash/conversion modes is out of MVP scope. In conversion mode the engine funds exactly `oiHaltLots * 1000` USDC atoms into OutcomeVault to mint OI complete sets. Specify token decimal conversion explicitly with the vault team. Long accounts receive positionLots YES lots plus floor(cashQ/Q) atoms; short accounts receive abs(positionLots) NO lots plus floor((cashQ+positionLots*1000*Q)/Q) atoms. Fractional refunds remain in the explicit residual ledger; token decimal conversion is agreed before enabling this extension. Refunds are nonnegative because backing was proven. Zero-position accounts receive cash only. Sets plus refunds equal pooled cash with only specified rounding dust. No account receives a cash payout as well as the same token entitlement.

The same immutable final outcome and INVALID price are delivered to OutcomeVault through its authorized resolution route. INVALID redeems YES at p and NO at 1−p; future-window pending behavior remains identical. Conversion must not allow free reserve withdrawal or bypass the freeze/funding/claim accounting. Deliver this extension after binary and INVALID cash paths, chunk retries, and claim conservation are verified. [B §14]

## Events, mocks, and acceptance contract with the other team

Emit engine-owned events sufficient for the external oracle, book indexer and UI:

```text
MarketHalted(marketId, snapshotId, economicHaltAt, haltRecordedAt,
             oiHaltLots, frozenAccountCount, frozenBookEpoch)
OracleFinalityAccepted(marketId, snapshotId, outcome)
InvalidPriceCaptured(marketId, priceE18, windowStart, windowEnd,
                     provenanceHash, reason)
SnapshotPreparationProgress(marketId, cursor, accountCount)
PayoutPreparationProgress(marketId, cursor, accountCount)
ClaimsEnabled(marketId, snapshotId, outcome, priceE18,
              totalTraderPayoutAtoms, reserveContributionAtoms)
Claimed(marketId, account, recipient, payoutAtoms)
```

Events may add engine index snapshots/status fields but must not claim that `snapshotId` is a full-ledger cryptographic commitment. Oracle proposal/dispute/UMA events remain the external team's responsibility. Frontend status examples are `halted, awaiting outcome`, `outcome final, preparing balances`, `INVALID final, waiting for scheduled TWAP window`, `preparation failed, retry available`, and `claims ready`; avoid showing “paid” on oracle finality alone.

Ship a `MockResolutionOracle` implementing only authorized calls and intentionally untrusted non-owner attempts. It can (a) halt early; (b) request scheduled halt late; (c) finalize YES/NO/INVALID; (d) repeat identical callbacks; (e) attempt a conflicting outcome; and (f) exercise delayed delivery. Do not emulate AI or UMA inside the engine repository. A deterministic mock index accumulator supplies complete, gapped, stale and future-window observations for INVALID tests.

Required seam acceptance cases:

- Only ResolutionOracle may halt early/finalize; adapter, monitor, keeper and arbitrary address cannot choose outcomes.
- Scheduled halt materialized late freezes economic cash at T/funding cutoffs, with identical payouts to an on-time halt; early halt uses its actual earlier timestamp.
- Rejected/disputed external assertions make no engine finalization call, and cannot resume a halted book. Engine waits without new funding/premium.
- Oracle Final accepted with 10,000 accounts performs no account loop or USDC payout; chunk jobs and claims subsequently complete in any safe batch size.
- Retrying halt, same finality, a chunk or claim cannot change the snapshot, price, liability, reserve debit or payout twice. Conflicting finality is rejected.
- Early YES/NO pays without waiting for T; early INVALID waits for the listed future window. Price capture uses the full fixed interval and never a halt-time replacement.
- New-listing horizon/capture/fallback tests exercise exact boundaries; legacy unconditional-TWAP markets never use the new midpoint fallback.
- Oracle Final plus pending TWAP or preparation reports the correct incomplete engine state; keeper retry progresses without asking UMA/AI for a new outcome.
- Halt OI includes reserve positions and uses lots; bond adapter conversion is unit-correct; final snapshot net positions equal zero.
- Aggregate trader payouts, reserve contribution, fee ledger and rounding residual reconcile before claims; one failing recipient cannot block another claim.
- Optional conversion cannot activate after a cash claim and cannot activate with any underbacked account, including the reserve.

These checks validate the seam. The external oracle team separately proves its own authorization, evidence, liveness, assertion and retry invariants; the engine neither duplicates nor weakens them.


# Math-first parallel implementation plan

**Execution plan v1.1 replaces the old P0–P5 / R001–R080 schedule.** The economic formulas, units, selected decisions DEC-01–DEC-14, role restrictions and release defaults remain the v1.0 baseline. This revision changes implementation order, task boundaries, module ownership and integration checkpoints. It does not authorize production leverage or deployment.

Start with the math engine. Both developers first build independent parts of a reference model, then the matching pure Solidity libraries. Only after the combined math-engine gate passes do you build custody, stateful accounting, real price ingestion and execution adapters. You do not wait until the end of the project to discover whether A's accounting and B's decisions agree.

## What “math engine first” means

The first executable deliverable has two layers:

1. **Independent reference calculation:** Python `Fraction` for exact ledger/funding/premium/payoff arithmetic; high-precision interval calculations for square roots and conservative risk bounds. It accepts data and returns results or state deltas. It does not hold tokens or fetch prices.
2. **Production calculation kernel:** pure Solidity libraries for those same calculations, with checked integer bounds and directed rounding. They accept immutable inputs and return values/deltas; they do not mutate protocol storage, call a feed, transfer USDC or match orders.

The reference is a test oracle, not a second authoritative production ledger. Expected outputs must be independently derived; do not call Solidity from Python to generate the supposedly independent expected answer. Model math in the reference first, verify its small examples, then port it. Inputs such as price samples, time, OI and hazard profiles are explicit fixture data during this phase. Real feed collectors, vaults and keeper jobs come later.

| Math ownership | Person A | Person B |
|---|---|---|
| Reference engine | Units, paired cash/position changes, endpoint deficits, reserve coverage, fixed-epoch funding, premium integration, fee/payoff/capital allocation | Horizon, hazards, volatility/tail/drift, MM/IM/health/caps, all-prefix order admission, pricing windows, liquidation decisions and clock/readiness predicates |
| Solidity kernel | QMath, LedgerMath, FundingMath, PremiumMath, CoverageMath, FeeMath, SettlementMath | HorizonMath, HazardMath, MarginMath, OrderAdmissionMath, PricingMath, LiquidationMath, LifecycleMath |
| Shared boundary | A produces exact economic state/delta values and directed numeric primitives | B consumes explicit state values and produces requirements/permissions/limits |
| Acceptance | Exact conservation, coverage, funding clearing and premium rounding | Conservative risk bounds, valid domains, monotone envelopes, safe admission and lifecycle decisions |

**Important independence point:** A delivers the common directed integer primitives at G1. B therefore starts the Solidity port with the real stable primitives available. B's W1 reference work does not depend on those Solidity functions. A does not wait for a live mark or book to implement funding or premiums; the agreed input records supply those values.

## Workload and scheduling rules

There are **88 owner-assigned tasks: 44 for A and 44 for B**, plus **eight shared integration stops, G0–G7**. Tasks start as not started. The old 80 tasks all map into the replacement backlog; the packet includes the complete migration table.

Effort points are relative planning estimates, not promised hours or completion dates. A 2-point task is small and bounded; 3 is moderate; 4 combines several correctness boundaries; 5 is a difficult algorithm or broad adversarial check. Each estimate includes its task-level tests and normal review fixes. Each person has 157 task points and an additional estimated 2 points per shared gate: **173 planned points each**. Equality of estimates does not guarantee equal elapsed time or difficulty for your particular skills.

Balance is checked within every work block, not only at the project total. Premium integration and funding reconciliation are deliberately matched with risk/admission and liquidation work of comparable estimated complexity. Both people implement core math, contract code and tests; neither is assigned only documentation or only the difficult math.

At each gate record actual effort and remaining uncertainty. If one lane is taking materially longer, the faster developer reviews difficult cases, writes independent acceptance fixtures or takes a specifically reassigned unstarted task. Update the owner map before that task starts. Do not move half-implemented files between agents silently or split ownership of a cash-mutating function to make the totals look equal.

## How parallel work is enforced

Each numbered work block contains an A lane and a B lane. A task may depend on an earlier task in its own lane and on the previous accepted gate; **there is no same-block dependency on the other person's unfinished task**. Both work from the same accepted interface version. Where the peer implementation is not yet ready, use a scripted test double of that agreed interface. A double checks expected calls and supplied results; it must not grow into a duplicate economic engine.

The gates are real synchronization points. A peer-mocked unit test can complete a lane task, but only real A+B components can clear the corresponding combined gate. G2 is the mandatory math-complete stop before any stateful protocol implementation. Later blocks retain explicit integration gates, with safe preparation work listed for the person who finishes early. Such preparation is not permission to mark a dependency-blocked task accepted.

Only the counterpart order-book, price-collector and resolution internals may remain mocked at the local completion gate. Their real integration is reported separately as pass or blocked. Never call a mock-only run a passed live integration.

## Repository ownership that prevents merge collisions

The proposed paths can be mapped onto an existing repository once, at G0. Keep those mappings in `docs/ownership.json`; do not create a second economic engine merely because an equivalent module already exists.

| Files/modules | Sole implementation editor | Consumption rule |
|---|---|---|
| `reference/a/`, common unit/fixture-result types, QMath and A accounting math libraries | A | B imports the accepted G0/G1 version; changes go through A |
| `reference/b/`, risk-function contracts, B risk/pricing/lifecycle math libraries | B | A consumes pure outputs and agreed values, not B private state |
| RiskStorage, AccountRegistry, vaults, AccountingPort, Accounting/Fee/ReserveAccounting | A | B reads snapshots and calls internal ports; never writes cash storage |
| FundingAccounting, PremiumAccounting, AccountSync, EpochRollover, ClearingCore | A | B supplies decisions/reservation changes; A owns mutation order and posting |
| PriceIngress/ObservationStore/RiskPricing, config/book/oracle interfaces and context port | B | A consumes a frozen RiskContext and explicit continuous-freshness cutoff |
| OrderRisk/OrderAdmission/BookRiskAdapter/OrderLifecycle/TradePreview | B | Calls A accounting port; actual CLOB topology is still the other team's work |
| TakeoverAccounting, LiquidationFees, FreezeAccounting, FloorAccounting, accounting event decoder | A | B authorizes and orchestrates; A moves paired cash/position and records escrow |
| RiskLifecycle/FloorLifecycle/liquidation controllers/RiskView | B | No direct vault transfer or independent cash mutation |
| SnapshotLedger/PayoutLedger/RecoveryAccounting/ClaimEscrow/ReserveClaims | A | Accept immutable finality/price from B; manage frozen liabilities and transfers |
| ResolutionIngress/InvalidPrice/SettlementController/ConversionGate and settlement/SDK facade | B | Controller drives A jobs; oracle outcome is never an instruction to set balances |
| `test/.../A/`, A mocks and A review reports | A | B reviews through findings; A edits |
| `test/.../B/`, B mocks and B review reports | B | A reviews through findings; B edits |
| `test/gates/Gn.t.sol`, `docs/contracts/Gn.json`, `artifacts/gates/Gn.json` | That gate's coordinator | New files per gate; both review. Global gate status has one writer at a time |

`ClearingCore` is the concrete composition module for the specification's Risk & Clearing layer inside MarketEngine. It is not a second independent engine. The book team owns matching topology; this team owns only the internal risk adapter. All economic posting stays in A-owned functions even when B decides the action.

The new task lists provide exact allowed write files. Each developer also owns the listed modules for later bug fixes; a fix must name its affected task/gate and rerun its checks. Do not use a broad “edit anything under contracts/” prompt for either AI agent.

## What to do at every pull stop

1. Each person finishes and tests the assigned block on their own branch or worktree. Commit working changes with task IDs and evidence. Do not discard or overwrite the other person's uncommitted work.
2. The named coordinator opens `integration/wN` from the prior accepted gate commit, merges the reviewed A and B branches, and runs the combined gate suite. Fixes go back through each module's owner; the coordinator does not rewrite their partner's module privately.
3. Both review the combined trace and interface changes. On success, merge the tested result to the shared main branch and record its actual commit hash in the gate record. A document tick or a green mock suite is not an accepted gate.
4. Both fetch and start the next block from that **same recorded commit**. This is the explicit point at which each person pulls the other's accepted work. Do not cherry-pick a selection that omits its fixtures, types or invariant checks.
5. If the combined test fails, the gate remains blocked. Continue the permitted own-module test/documentation preparation while fixing the concrete issue. An interface change invalidates the relevant prior compatibility result and must be versioned and rerun.

For separate checkouts, the next-block pattern is:

```bash
# First commit or otherwise preserve your own current work.
git status --short
git fetch origin
# Replace the placeholders with the accepted gate SHA and your identity.
git switch -c risk/w4-a <G3_MERGE_SHA>
# Person B uses risk/w4-b from the identical G3_MERGE_SHA.
```

For local parallel AI agents, give them separate Git worktrees and the same recorded starting commit. Do not let two agents change branches in one working directory. Review work through commits/PRs, not by copying changed files between folders. These are workflow instructions; this document has not created or merged a repository.

## Task acceptance and evidence

Every task specifies owner, relative effort, allowed write files, dependencies, output, a future acceptance command, acceptance assertions and the gate that consumes its result. Run commands from the repository root unless the command explicitly changes directory. W0/W1 reference suites use Python; W2 ports use the math harness; later task checks use contract or integration harnesses. `scripts/check-task.sh` and `scripts/check-gate.sh` are required deliverables in A002, not existing tools supplied by this PDF.

Record task/gate ID, actual commit, specification and interface versions, command, exit code, fixtures/seeds, artifact paths and real/mock component status. Never generate a passing result merely because the plan names a test. If repository tooling is absent, that task remains unverified until it is installed/pinned and actually run.

The 26 arithmetic checks shipped with the original document remain useful starter fixtures. They are not the new math engine, do not satisfy G1/G2 by themselves, and are not a substitute for the reference/Solidity differential tests in the new backlog. This revision validates the **plan** and preserves those fixtures; it does not claim to have implemented any of the 88 tasks.

## Handling work already started under the old plan

Use `task_migration.csv` or JSON to locate every old R task. Some old tasks split into reference, pure Solidity and stateful wiring; others join one new atomic deliverable. Keep useful code and evidence, but check it against the new boundaries before crediting a new task. Do not treat new IDs as an instruction to throw away existing work or automatically mark its replacement complete. The new A/B assignments and gates are authoritative for scheduling from this revision onward.

## External team dependencies remain explicit


| ID | Counterpart deliverable | Required risk-side contract and local substitute | Join condition |
|---|---|---|---|
| CP-BOOK | CLOB matcher, FIFO/bitmap/slot storage, matching and order cancellation | Internal `IBookRiskHooks` contract; `MockBookAdapter` supports committed limit orders, exact fills, cancellations and bounded liquidation fills | Counterpart passes the same hook vectors; order ID/generation, lot units, fill fees and cancellation epoch are identical |
| CP-PRICE | Spot/index source collector and venue-depth read capability | `IPriceSource` signed/authorized observation envelope and `MockPriceSource`; B implements selected risk aggregation and guards, not Kuru/CRE fetching | Sample sequence, observed/published/accepted times, depth-size units, stale behavior and revision policy match |
| CP-ORACLE | Immutable listed rules, authorized halt, final YES/NO/INVALID, OI-at-halt consumer | `IResolutionIngress` and `MockResolutionAuthority`; no CRE, model, committee or UMA code | Only configured authority can halt/finalize; enum-to-payoff mapping explicit; state/attempt callbacks cannot pay twice |
| CP-FACTORY | Factory/registry wires isolated engines and approved addresses/config | `IMarketConfig` plus immutable fixture/factory harness | Risk bounds, scheduled time, source permissions and INVALID rule match listing and cannot be rewritten by a price callback |
| CP-TOKEN | Native OutcomeVault/YES-NO token behavior, when used by the selected release | `IOutcomeSettlement` mock only; primary cash-settlement implementation does not implement outcome tokens | Optional conversion stays disabled until separate token-accounting integration passes; no inferred requirement to ship it with cash settlement |
| CP-APP | Indexer and frontend consume events/views | JSON/ABI fixtures and `RiskView` schema produced by this team; no web pages or GraphQL server | UI values reproduce contract previews at a named block; pending/unfinalized estimates cannot masquerade as claimable cash |

A missing counterpart deployment is not a reason to stop implementing this package: run the shared interface fixtures against its deterministic mock. It does block the real integration gate. The coding agent must never label a mock-only pass as the live counterpart passing. [B §§16,18, pp.27–33; O §§9–11, pp.18–23; D §§9.8,11, pp.17,21–23.]


## Parallel work blocks and pull stops

Each row is one block of concurrent work. Finish G0, then W1/G1, W2/G2 and so on. G2 is the math-engine completion gate. The exact tasks and their intra-lane order follow later.

| Block | A lane | B lane | Pull stop |
|---|---|---|---|
| W0: Agree the math contract | A001–A002: Units, types and test runners. 4 points. | B001–B002: Function contracts, ownership and golden cases. 4 points. | G0 |
| W1: Build the independent reference engine | A003–A009: Ledger, cover, funding, premiums, payoff; shared QMath. 27 points. | B003–B009: Risk, margin, admission, pricing, liquidation and clocks. 27 points. | G1 |
| W2: Build and verify pure Solidity math | A010–A015: Pure accounting/funding/premium/payoff libraries. 24 points. | B010–B015: Pure risk/admission/pricing/lifecycle libraries. 24 points. | G2 |
| W3: Build state and pricing foundations | A016–A021: Vault, storage, posting, reserve and accounting port. 21 points. | B016–B021: Observation ingress/store, context, ports and mocks. 21 points. | G3 |
| W4: Connect accrual and trading admission | A022–A027: Funding, premium, sync, rollover and clearing. 23 points. | B022–B027: Reservations, admission, internal book hooks and previews. 23 points. | G4 |
| W5: Build lifecycle and liquidation | A028–A033: Takeover, fees, freeze, floor accounting and events. 21 points. | B028–B033: Stages, grace, floor and liquidation controllers. 21 points. | G5 |
| W6: Build resolution and cash settlement | A034–A039: Frozen ledger, payouts, escrow, claims and capital exit. 21 points. | B034–B039: Finality, INVALID capture, jobs, oracle seam and views. 21 points. | G6 |
| W7: Verify and hand off the integrated system | A040–A044: Accounting invariants, gas, custody and peer review. 16 points. | B040–B044: Lifecycle/counterparts, gas, SDK and peer review. 16 points. | G7 |

No same-block peer-task dependency appears in the declared graph. This is a planning property, not a promise that no unexpected interface defect will be found. Defects are resolved at the named gate through the owner map.

## G0 — STOP, integrate and both pull: Math contract frozen

**After:** W0 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A units/types and runner; B function contracts, ownership and independently derived fixtures.

**Run together:** Resolve unit/enum/domain differences, compile a shared pure-input smoke fixture, and commit one MathTypes/QMath signature version. Both pull this commit before algorithm implementation.

**Gate passes only when:** Units, fixture schema, pure function signatures, directed-rounding conventions and the owner map are identical on both worktrees. No vault/feed/engine implementation has started.

**Both pull:** the actual merged commit recorded for G0; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G0` on the combined branch. **Frozen output:** G0 math contract and golden-fixture schema.

**If your partner is still finishing:** Review additional hand-derived boundary cases in your own fixture/test area; do not implement algorithms against unagreed types.

## G1 — STOP, integrate and both pull: Reference engines and numeric primitives joined

**After:** W1 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A rational ledger/coverage/funding/premium/payoff plus QMath; B high-precision risk/pricing/liquidation/clock references.

**Run together:** Run one combined reference trace: paired trade, margin/admission, funding, premium, liquidation decision, and terminal payoff. Compare QMath with rational bounds; freeze its callable interface for the Solidity port.

**Gate passes only when:** One unified reference engine can calculate both sides of the fixture; no placeholder port remains in the combined reference run. QMath directed-bound tests pass.

**Both pull:** the actual merged commit recorded for G1; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G1` on the combined branch. **Frozen output:** G1 reference outputs, QMath interface and math fixture hashes.

**If your partner is still finishing:** Prepare test cases and documentation for your own W2 library signatures; do not finalize a port against a QMath interface that G1 has not accepted.

## G2 — STOP, integrate and both pull: MATH ENGINE COMPLETE

**After:** W2 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A pure Solidity accounting libraries; B pure Solidity risk/pricing/lifecycle libraries and both differential reports.

**Run together:** Compose real A and B pure libraries in the math harness. Run direct5x entry, short 100-vs80 margin, all-prefix admission, reserve funding payer/receiver, neutral-touch premium, halt cutoffs and all payoff modes. Freeze stateful internal port schemas for W3.

**Gate passes only when:** The reference and pure Solidity engines agree exactly or within each declared conservative bound. No token/storage/network dependency appears in the math layer. Both approve the backend input/output port contracts. Stateful build is blocked until this gate passes.

**Both pull:** the actual merged commit recorded for G2; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G2` on the combined branch. **Frozen output:** G2 math-engine fixture hashes and backend port contracts.

**If your partner is still finishing:** Add invariant/boundary cases or measure your own pure functions locally. Do not begin vaults, real feed ingress or stateful clearing before G2 passes.

## G3 — STOP, integrate and both pull: Storage and risk context joined

**After:** W3 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A real custody/ledger/coverage ports; B real observations/context plus scripted counterparts.

**Run together:** Replace the A/B doubles in a combined harness: allocate collateral, compute a fresh context and margin from actual stored account values, exercise bootstrap and checked release decision. Freeze action/accrual/reservation delta contracts for W4.

**Gate passes only when:** Actual account snapshots and RiskContext use the same Q/lot/version cutoffs. Bootstrap has a valid startup path; guarded release cannot bypass the real risk decision. Book/oracle remain explicitly mocked.

**Both pull:** the actual merged commit recorded for G3; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G3` on the combined branch. **Frozen output:** G3 real state/read ports, accrual/action ABI and book hooks.

**If your partner is still finishing:** Prepare own W4 unit fixtures and mocks against G2-frozen ports; any integration-dependent completion waits for G3. Do not change a peer-owned interface locally.

## G4 — STOP, integrate and both pull: Trading with real accrual joined

**After:** W4 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A funding, premium, account sync, rollover and clearing; B reservations, admission, book adapters and previews.

**Run together:** Wire real A account-touch/posting into real B hook orchestration. Run rest→maker touch→paired fill→fees→coverage→permit release, then epoch rollover, cancellation and withdrawal.

**Gate passes only when:** No scripted A/B peer port remains in trading tests. Each fill sees updated OI/cash/coverage; neutral premium touches agree; old epochs cannot release new reservations. Unexpected assertion rolls back all prior fills.

**Both pull:** the actual merged commit recorded for G4; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G4` on the combined branch. **Frozen output:** G4 working trading engine and liquidation/freeze port contracts.

**If your partner is still finishing:** Work on additional own-module fuzz cases and W5 scenario inputs. A takeover or B liquidation implementation may be prepared only against the accepted previous interface, with completion held until G4.

## G5 — STOP, integrate and both pull: Liquidation and freeze joined

**After:** W5 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A takeover/fees/freeze/floor accounting; B stage/grace/eligibility/book-close/lifecycle.

**Run together:** Run real pair reduction, bounded book reduction, NEEDS_MORE_WORK, authorized takeover, floor sweep and halt during every rollover-page state. Freeze snapshot and payout job port schemas for W6.

**Gate passes only when:** Small caller budget never causes positive-equity takeover. Both reserve sides and keeper liabilities remain correct; actual economicHaltAt is distinct from the shared accrual cutoff. No live mutation occurs inside a frozen sweep.

**Both pull:** the actual merged commit recorded for G5; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G5` on the combined branch. **Frozen output:** G5 frozen snapshot/job interfaces and real liquidation traces.

**If your partner is still finishing:** Prepare your own W6 payout or finality edge-case vectors against G5-design schemas; do not finalize combined snapshot assumptions before the G5 version is merged.

## G6 — STOP, integrate and both pull: Resolution-to-cash joined

**After:** W6 · **Coordinator:** A · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A frozen-ledger/payout/escrow/claims/reserve exits; B finality/INVALID/controller/readiness.

**Run together:** Use real A settlement ledger with real B controllers through YES, NO and earlyINVALID. Vary pages and claim order; test fee fractions and LP redemption before remaining user claims.

**Gate passes only when:** Finality acceptance is constant work; claims wait for immutable price and complete allocation; retries are exactly once; all trader/fee/keeper/reserve Q stays classified. Conversion/recovery flags remain selected defaults.

**Both pull:** the actual merged commit recorded for G6; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G6` on the combined branch. **Frozen output:** G6 end-to-end cash-settlement engine; frozen ABI for hardening.

**If your partner is still finishing:** Expand own completed settlement tests, documentation and gas fixtures. Do not produce a final all-module report using peer mocks.

## G7 — STOP, integrate and both pull: Integrated handoff accepted

**After:** W7 · **Coordinator:** B · **Approval/review:** A and B · **Planned gate effort:** 2 points each.

**Exchange:** A accounting invariants/gas/custody evidence and review; B lifecycle/counterpart/gas/SDK evidence and review.

**Run together:** Run both campaigns from one clean merged commit, resolve cross-review findings through the owning developer, and assemble release/counterpart status. Both pull and replay the final commit.

**Gate passes only when:** Local end-to-end tests use real A+B modules and complete evidence. Real external counterpart integration is explicitly PASS or BLOCKED_BY_COUNTERPART with mock status; only a real pass clears the live join. Calibration/audit/deployment remain distinct release gates.

**Both pull:** the actual merged commit recorded for G7; dependent tasks use its frozen contract version. Run `bash scripts/check-gate.sh G7` on the combined branch. **Frozen output:** G7 release manifest and real-vs-mock counterpart status.

**If your partner is still finishing:** Fix findings in your owned modules and rerun affected suites; do not weaken invariants or report mock-only counterpart success as real integration.

## Concrete example: working independently in W4

A builds the real account-touch sequence: funding, premium, cushion retirement, deficit replacement and atomic posting. A tests it against a scripted decision port that returns agreed inputs and accept/reject results. B independently builds reservations, maker re-admission and the bounded book adapter against a scripted accounting port with the same G3 signatures. B does not copy funding/premium logic into its mock; A does not copy margin/admission logic into its mock.

At G4, join the real modules. An incoming order obtains B's risk context and permit; A synchronizes maker/taker to the legal cutoff; B rechecks admission; A posts both legs and fees; B updates the order lifecycle; the combined action verifies reserve coverage and permit cleanup. If the interface or sequencing is wrong, G4 fails even when both separate mock suites were green. Fix it in the owning module, rerun, merge, and both start W5 from that accepted commit.


# Worked ledger and release verification

## One bilateral leveraged position through all three outcomes

This is a local arithmetic fixture, with leverage enabled only for the fixture. Reserve seed is 100,000 USDC; Alice deposits 120 and buys 1,000 claims at 0.60 from Bob, who deposits 100. Trading fees and funding are zero in this subfixture; premium clock has not advanced. Both traders fit the2,000-USDC per-account deficit cap. The mark is 0.60 and the selected29-day risk fixture permits IM120 long and approximately95.894 short. Actual implementation must also pass the normal price, account and epoch gates.

| Quantity | Alice, long | Bob, short | Reserve |
|---|---:|---:|---:|
| Position, claims | +1,000 | −1,000 | 0 |
| Cash after fill, USDC | −480 | 700 | 100,000 |
| Equity at mark0.60 | 120 | 100 | 100,000 |
| NO value | −480 | 700 | 100,000 |
| YES value | 520 | −300 | 100,000 |
| NO deficit | 480 | 0 | Guarantee account |
| YES deficit | 0 | 300 | Guarantee account |

Market cash is 100,220 USDC throughout the fill. Reserve minimum required by this isolated payoff example is 480, because only one outcome occurs; the selected actual seed is larger to satisfy concentration and other gates. Do not add480+300 as a simultaneously payable loss.

| Final payoff | Alice claim | Bob claim | Total trader claims | Reserve residual |
|---|---:|---:|---:|---:|
| NO, p=0 | 0 | 700 | 700 | 99,520 |
| YES, p=1 | 520 | 0 | 520 | 99,700 |
| INVALID, p=0.5 | 20 | 200 | 220 | 100,000 |

All amounts are USDC. These claims are allocated before any transfer. An INVALID p=0.5 here is a calculation example; the live price must still come from the immutable capture rule or its disclosed missing-data fallback.

## What was verified while writing this specification

The companion `verify_spec_vectors.py` executed 26 exact/high-precision checks covering lot/tick/Q conversions, binary and INVALID payouts, oversized asks, exact cancellation values, reserve funding payer/receiver cases, changing OI budgets, cumulative premium integration, a positive-part zero crossing, takeover slack and fractional fee escrow. The premium and ledger checks use rational/integer arithmetic. The risk-margin example uses60-digit Decimal arithmetic; a separate numerical array checks all 1,000,000 positive lot prefixes of that single direct 5x fixture. Its maximum IM is 120 USDC. The general monotonic-envelope argument is stated in the order-admission contract; numerical agreement alone is not its proof.

These checks validate the document's arithmetic, not a deployed implementation. No production Solidity contracts, live book/oracle integration, market calibration, gas benchmark, external security audit or economic stress simulation was performed in this writing task. Each ticket below names future implementation evidence separately. The machine-readable results preserve this distinction.

## Specification review findings incorporated

| Finding | Implemented specification correction | Required implementation regression |
|---|---|---|
| Empty book cannot create its own mandatory mark history | Exactly backed index-only bootstrap; normal pricing after full warm-up at an epoch opening | Deploy with no orders; seed depth; accumulate windows; enter normal mode |
| Tiny caller liquidation budget could cause positive-equity takeover | Shortage/exhausted work returns NEEDS_MORE_WORK; takeover eligibility is explicit | Ample book plus maxLots/maxSteps too small cannot confiscate |
| Halt before any overdue rollover page could accrue unapproved time | `accrualCutoff=min(haltEventTime,activeEpoch.end)` regardless of keeper call order | Compare halt-before-roll and roll-before-halt at same cutoff |
| A late fresh observation could erase a stale funding interval | Continuous freshness endpoint; no restart inside stopped epoch | Old sample expires; late new sample cannot fund the gap |
| Keeper fractions could be released to LPs | Exact Q keeper/protocol escrow precedes reserve residual | Half-atom reward survives LP redemption and later keeper withdrawal |
| Endpoint-only IM claim missed interior risk behavior | Adverse contribution equity bound plus certified monotone sign envelopes | All-prefix direct leverage and artificial nonmonotone input rejection |
| Premium-on-touch wording implied unsupported compounding | Cumulative affine integral, neutral-touch invariance, epoch capitalization | Repeated neutral sync equals one delayed sync |

**Primary review verdict: conditional on a named input**—a faithful bounded integer implementation of the stated assumptions, with the required calibration and integration evidence. The focused review reconstructed local funding, premium and endpoint identities under their stated hypotheses. Full protocol correctness remains conditional on the actual integer implementation, complete interface integration and calibrated inputs. This is a transparent design review record, not a substituted security-audit certificate.

## Minimum end-to-end acceptance scenario

1. Deploy local mocks, vault and one market with the exact fixture manifest; seed locked reserve capital and record addresses/config hashes.
2. Fund two user free balances; allocate collateral. Bootstrap exactly-backed quotes from an empty book while the independent index is valid.
3. After valid observation windows and an epoch opening, activate the fixture-only leverage/funding flags; enter the bilateral leveraged position through real risk hooks and mock book traversal.
4. Accrue funding at the fixed rate, change OI through another paired trade, collect premium at different touch times and prove same-segment totals agree.
5. Insert stale orders and advance a risk epoch; verify bounded prune behavior and that a rollover blocks market-ledger mutation until all pages finish.
6. Trigger margin shortfall. Exercise partial safe reduction, limited-work continuation, zero-effect calls, and authorized full-account takeover in distinct fixtures.
7. Halt before T and at T in separate runs; snapshot interrupted rollovers and inactive zero-position cash holders. Deliver duplicate and conflicting finality.
8. Complete YES, NO and early INVALID paths; keep early INVALID pending until capture eligibility, then test both complete TWAP and the disclosed missing-data fallback.
9. Prepare claims in different batch sizes/orders, withdraw a keeper atom balance with residual Q, and redeem matured reserve shares before some trader claims are clicked. Every claimant still receives its fixed entitlement.
10. Reconstruct recognized custody and each market ledger from events/views, compare independent reference output, and record which counterpart contracts are mocks versus real implementations.

# Source coverage and exclusions for this work package

This standalone implementation package retains the risk-layer obligations from the original documents and states every selected amendment. The separate master document preserves the full source PDFs and historical alternatives. This package does not copy unrelated AI prompts or CLOB storage algorithms into the middle-layer team's backlog.

| Source area | Where it is implemented here | Treatment |
|---|---|---|
| B §§1–4: product, units, signed ledger | Scope, units, custody and invariant contracts | Paper1 only; Q precision made explicit |
| B §§5–8: bounded loss, hazards, margin and caps | Pricing/margin kernel and all-prefix admission | Conservative linear hazard/drift envelopes; initial1x deployment |
| B §9: jump reserve, premium, capital, waterfall | Accounting chapter, locked capital and disabled recovery calculator | Fixed epoch premium policy, exact funding cushion, terminal LP liquidity |
| B §10: liquidation, risk epochs, grace and final day | Lifecycle, partial reduction and bounded floor sweep | Honest materialization gate; no shortage-only positive-equity takeover |
| B §11: order collateral, matching checks and order epochs | Typed internal book seam, return codes andboundary fixtures | Exact price/fee release, full epoch sidecar, current maker checks |
| B §12: funding | Fixed-rate authorized epoch budget, freshness stop, contra ledger | No rate reversal or historic catch-up within epoch |
| B §13: independent index and bounded mark | Price observations, TWAPs, bootstrap and calibration manifest | Current chain/feed implementation verified at integration gate |
| B §14: halt, payoff, INVALID, conversion | Oracle seam, bounded preparation, claims and disabled conversion | Future-window waiting and disclosed new-listing fallback |
| B §15 / O §§1–11: resolution | Authenticated halt/finality/OI interfaces | O governs consensus; middle layer does not implement models or UMA |
| B §§16–18 and D §9.8: contracts/invariants/testing | Repository, owners, task DAG and release gates | Internal composition and deterministic counterpart mocks |
| B §§19–21: examples, risks and parameters | Corrected fixtures and manifest | Source examples with concentration/premium exceptions are not executable truth |
| D alternative economic architecture | Explicit precedence and decision register | Preserved in master; not silently mixed into this baseline |
| R: primary project plan | Paper1 scope context | Reference only; Papers2/3 mechanisms excluded |

Before coding against an existing repository, map its actual module paths and pinned dependencies to the proposed tree. Preserve one authoritative ledger and the selected semantic version. If the counterpart book or oracle ABI differs, report the exact incompatible field/call and provide a versioned adapter; do not silently cast enums, units or packed widths.


# Atomic implementation backlog — parallel plan v1.1

88 implementation tasks are individually owned; G0–G7 are eight separate joint integration stops. Every task and gate is initially not started. Effort is an estimate; acceptance commands below must be implemented and run in the actual repository. The math engine occupies W0–W2 and must pass G2 before stateful construction.

| Block | A tasks / points | B tasks / points | Gate coordinator |
|---|---:|---:|---|
| W0 | 2 / 4 | 2 / 4 | A |
| W1 | 7 / 27 | 7 / 27 | B |
| W2 | 6 / 24 | 6 / 24 | A |
| W3 | 6 / 21 | 6 / 21 | B |
| W4 | 6 / 23 | 6 / 23 | A |
| W5 | 6 / 21 | 6 / 21 | B |
| W6 | 6 / 21 | 6 / 21 | A |
| W7 | 5 / 16 | 5 / 16 | B |
| Total task work | 44 / 157 | 44 / 157 | Four gates coordinated each |
| Shared gate participation | 8 / 16 | 8 / 16 | Both review every gate |
| Total estimated work | 173 points | 173 points | Estimates, not hours |

A same-lane dependency is written explicitly. The previous G gate makes all earlier accepted cross-lane outputs available; do not add a dependency on the peer's unfinished same-block implementation when a frozen input/output port suffices. `write_files` is an allowlist; counterpart implementations stay read-only. Old R IDs are migration links, not additional unfinished tasks to execute again.

## W0 — Agree the math contract

**Start from:** the published selected specification; reconcile at G0. **Next stop:** G0. Both lanes are independent within this block.

### Person A

**A001 · Freeze units and pure calculation input types**

**Owner:** A · **Effort:** 2 points · **Dependencies:** None; G0 reconciles the shared contract · **Hand off at:** G0.

Encode lot, tick, Q, signed rounding, position/cash bounds and explicit outcome encodings. Define pure account, order, funding and payoff input records from the selected specification; do not create vault storage.

**Write only:** `reference/common/units.py`, `contracts/src/math/MathTypes.sol`, `docs/math/units.md`, `reference/tests/a/test_a001.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a001.py"`.

**Required result:** One lot at one tick equals one atom; mark equity has no extra WAD division. Types name units and prohibit implicit oracle-enum casts.

**Replaces/splits:** R001, R002, R004. Full original source anchors remain in task JSON.

**A002 · Create math test runners and evidence schema**

**Owner:** A · **Effort:** 2 points · **Dependencies:** A001 · **Hand off at:** G0.

Prepare separate A/B test discovery, exact-fixture result schema, compiler/dependency lock declarations and deterministic seeds. Gate commands must execute checks and fail on missing suites; this task does not implement economic functions.

**Write only:** `scripts/check-task.sh`, `scripts/check-gate.sh`, `reference/common/result_schema.json`, `contracts/foundry.toml`, `reference/tests/a/test_a002.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a002.py"`.

**Required result:** A and B smoke fixtures run independently; an intentionally failing or missing suite produces nonzero exit status. No production deployment is configured.

**Replaces/splits:** R006, R079, R080. Full original source anchors remain in task JSON.

### Person B

**B001 · Freeze risk function contracts and ownership map**

**Owner:** B · **Effort:** 2 points · **Dependencies:** None; G0 reconciles the shared contract · **Hand off at:** G0.

Declare the pure risk, pricing, lifecycle and liquidation function inputs/outputs using the published units. Record single-editor module ownership and external CP-BOOK/PRICE/ORACLE/FACTORY/APP boundaries; reconcile units with A at G0.

**Write only:** `docs/math/risk-function-contracts.json`, `docs/ownership.json`, `docs/counterpart-contracts.md`, `reference/tests/b/test_b001.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b001.py"`.

**Required result:** Each function has an explicit domain, rounding direction and unavailable/error result; ownership has no duplicate writers. Full CLOB and AI/UMA internals stay outside scope.

**Replaces/splits:** R001, R003, R008, R009. Full original source anchors remain in task JSON.

**B002 · Author independent golden scenarios**

**Owner:** B · **Effort:** 2 points · **Dependencies:** B001 · **Hand off at:** G0.

Manually derive small binary/interior payoff, direct-leverage, stale-price, time-boundary, margin and takeover cases from the selected rules. Store inputs and expected results with derivation labels; do not obtain expected values by calling the implementation being tested.

**Write only:** `reference/fixtures/golden_cases.json`, `docs/math/golden-case-rationale.md`, `reference/tests/b/test_b002.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b002.py"`.

**Required result:** Cases include long/short/flat, zero equity, 17 lots at tick 613, future-window INVALID and a 29-day direct5x long. Distinguish exact ledger values from high-precision risk intervals.

**Replaces/splits:** R015, R017, R023, R071, R073. Full original source anchors remain in task JSON.

**STOP at G0:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W1 — Build the independent reference engine

**Start from:** the exact accepted G0 commit. **Next stop:** G1. Both lanes are independent within this block.

### Person A

**A003 · Implement rational ledger and terminal equity**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G0 · **Hand off at:** G1.

Implement paired signed fills, cash transfers, position conservation and NO/YES/interior raw equity with Fraction arithmetic. Produce state deltas without persistence or token calls.

**Write only:** `reference/a/ledger.py`, `reference/tests/a/test_a003.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a003.py"`.

**Required result:** 17@613 transfers10421 atoms; long 120 USDC and short 100 USDC at 1000 claims/.6 yield cash−480/700, with net position zero and exact paired cash conservation.

**Replaces/splits:** R006, R014, R015, R017. Full original source anchors remain in task JSON.

**A004 · Implement exact order-deficit and reserve calculations**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G0, A003 · **Hand off at:** G1.

Calculate fee-aware order endpoint deficits, trader sums, reserve endpoint values, concentration limit and coverage slack. Keep pending premium and future funding allowance distinct.

**Write only:** `reference/a/coverage.py`, `reference/tests/a/test_a004.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a004.py"`.

**Required result:** The1-claim/cash0 ask2.3@.55 is rejected at 1x; both reserve outcomes are checked independently and pending premium credits/debits preserve coverage.

**Replaces/splits:** R025, R026, R033, R034. Full original source anchors remain in task JSON.

**A005 · Implement funding transition reference**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G0, A003, A004 · **Hand off at:** G1.

Model fixed-rate epochs, per-step old OI, budget consumption, reserve payer/receiver, funding clearing and attributable cushion retirement. Accept time/freshness cutoffs as explicit inputs.

**Write only:** `reference/a/funding.py`, `reference/tests/a/test_a005.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a005.py"`.

**Required result:** Reserve+40/trader+60/−100 atdeltaF.01 moves.4/.6/−1 and preserves slack. OI changes, zero OI, stale gaps and exhausted budget cannot create catch-up funding.

**Replaces/splits:** R027, R028, R029. Full original source anchors remain in task JSON.

**A006 · Implement clipped-affine premium integration**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G0, A005 · **Hand off at:** G1.

Integrate the positive part of each funding-affine deficit analytically, split at funding stop, and charge differences of one cumulative upward-rounded Q integral. Retain origin across neutral touches.

**Write only:** `reference/a/premium_integral.py`, `reference/tests/a/test_a006.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a006.py"`.

**Required result:** Deficit100→110 over 1h atloadedhazard.0002/day costs.000875 USDC. Crossing triangles match rational integration and neutral sync does not change the charge.

**Replaces/splits:** R030. Full original source anchors remain in task JSON.

**A007 · Implement premium surcharge and epoch capitalization**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G0, A006 · **Hand off at:** G1.

Apply the account-wide4x six-hour renewal only to new principal deficit; split at expiry. Exclude current-epoch paid premium from the tariff base, then capitalize once at completed rollover.

**Write only:** `reference/a/premium_epochs.py`, `reference/tests/a/test_a007.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a007.py"`.

**Required result:** The preceding premium becomes.0035 USDC during4x. Funding/premium-only touches do not renew expiry; repeated rollover pages do not capitalize twice.

**Replaces/splits:** R031, R032. Full original source anchors remain in task JSON.

**A008 · Implement payout, fee-escrow and capital arithmetic**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G0, A003 · **Hand off at:** G1.

Calculate positive raw claims, atom floors, exact keeper/protocol Q escrow, reserve residual, frozen-share entitlements, capped backstop and disabled pro-rata recovery amounts as pure functions.

**Write only:** `reference/a/settlement.py`, `reference/tests/a/test_a008.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a008.py"`.

**Required result:** YES/NO/INVALID claims conserve assets; half-atom keeper liability survives reserve redemption. P=0 and fractional residuals have explicit owners; recovery remains disabled by default.

**Replaces/splits:** R035, R036, R037, R066, R067, R068, R070. Full original source anchors remain in task JSON.

**A009 · Implement directed integer primitives for both tracks**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G0, A003 · **Hand off at:** G1.

Implement checked signed floor/ceil division, full-product directed division, sqrtUp, bounds and Q/atom/lot conversions. Publish pure signatures frozen for B before G1; no protocol state.

**Write only:** `contracts/src/math/QMath.sol`, `reference/a/integer_bounds.py`, `reference/tests/a/test_a009.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/a -p "test_a009.py"`.

**Required result:** Negative signed division differs correctly from truncation; overflow edges fail explicitly. sqrtUp brackets the exact square root and all conversions match A003/B002 independent values.

**Replaces/splits:** R007, R017. Full original source anchors remain in task JSON.

### Person B

**B003 · Implement horizon and volatility reference**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G0 · **Hand off at:** G1.

Compute size and queue-dependent closeout horizon and the maximum theoretical/empirical/template volatility bound. Enforce nondecreasing empirical horizon envelopes and unavailable-calibration behavior.

**Write only:** `reference/b/horizon_volatility.py`, `reference/tests/b/test_b003.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b003.py"`.

**Required result:** Zero size, nearT, large size and queued closeout are handled. Noisy decreasing calibration is rejected or converted by the declared conservative envelope rule.

**Replaces/splits:** R018, R020. Full original source anchors remain in task JSON.

**B004 · Implement hazard, tail and drift reference**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G0, B003 · **Hand off at:** G1.

Implement selected linear hazard upper bounds, directional adverse probability, residual tail budget, Cantelli factor and conservative drift. Use high-precision directed intervals for nonrational operations.

**Write only:** `reference/b/hazards.py`, `reference/tests/b/test_b004.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b004.py"`.

**Required result:** Adverse probability at epsilon or exhausted denominator forces full backing. Long/short direction swaps are correct and no favorable hazard term understates drift.

**Replaces/splits:** R019, R021. Full original source anchors remain in task JSON.

**B005 · Implement margin, health and template reference**

**Owner:** B · **Effort:** 5 points · **Dependencies:** G0, B003, B004 · **Hand off at:** G1.

Compute MM, IM, full-backing switch, directional/template caps, health and displayed leverage. Include zero/negative equity and prove the per-sign monotone envelope assumptions.

**Write only:** `reference/b/margin.py`, `reference/tests/b/test_b005.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b005.py"`.

**Required result:** The29-day fixture requires longIM120 USDC and shortIM about 95.894 USDC; short collateral80 fails and 100 passes. Missing calibration gives1x, not guessed leverage.

**Replaces/splits:** R017, R022, R023, R024. Full original source anchors remain in task JSON.

**B006 · Implement all-prefix order admission reference**

**Owner:** B · **Effort:** 5 points · **Dependencies:** G0, B005 · **Hand off at:** G1.

Compute conservative marked-fill deductions with maxBid/minAsk, reachable sign intervals, certified IM envelopes and bounded halving quantity selection. Accept endpoint-deficit/coverage values via a scripted input port until G1.

**Write only:** `reference/b/order_admission.py`, `reference/tests/b/test_b006.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b006.py"`.

**Required result:** Direct5x entry can pass; sign flips and an artificial interior IM hump cannot bypass the envelope. Enumerate small order-fill mixtures and compare all accepted prefixes.

**Replaces/splits:** R042, R043, R046. Full original source anchors remain in task JSON.

**B007 · Implement pure time-weighted pricing reference**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G0 · **Hand off at:** G1.

Calculate valid-interval TWAP integrals, gaps, basis/mark median and clamp, and epoch funding recommendation from supplied observations. Do not fetch external venues or verify network signatures yet.

**Write only:** `reference/b/pricing.py`, `reference/tests/b/test_b007.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b007.py"`.

**Required result:** Irregular sample spacing is time-weighted;30-second gaps are not carried through; mark inputs/clamp and beta0 rate quantization obey explicit units.

**Replaces/splits:** R038, R039, R040, R041. Full original source anchors remain in task JSON.

**B008 · Implement liquidation decision reference**

**Owner:** B · **Effort:** 5 points · **Dependencies:** G0, B005 · **Hand off at:** G1.

Calculate eligible reduction, conservative size estimate, fee-aware bankruptcy tick and pacing decisions from immutable inputs. Return NEEDS_MORE_WORK on work exhaustion; model takeover authorization separately.

**Write only:** `reference/b/liquidation.py`, `reference/tests/b/test_b008.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b008.py"`.

**Required result:** Positive equity plus small caller budget cannot authorize takeover. Invalid roots use bounded full-close attempt; each proposed close is rechecked against actual size-dependent margin.

**Replaces/splits:** R050, R052, R053, R054, R055, R056, R057. Full original source anchors remain in task JSON.

**B009 · Implement clock and settlement-readiness reference**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G0 · **Hand off at:** G1.

Model derived stages, grace anchors, funding/epoch/halt cutoff precedence, bootstrap transition, INVALID window readiness and same/conflicting finality outcomes as pure transitions.

**Write only:** `reference/b/lifecycle.py`, `reference/tests/b/test_b009.py`.

**Acceptance command:** `python -m unittest discover -s reference/tests/b -p "test_b009.py"`.

**Required result:** Halt-before-roll and roll-before-halt share the same accrual cutoff; earlyINVALID waits for T; missing index uses only the disclosed fallback rule. No clock alone rewrites balances.

**Replaces/splits:** R047, R048, R049, R058, R061, R064, R065. Full original source anchors remain in task JSON.

**STOP at G1:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W2 — Build and verify pure Solidity math

**Start from:** the exact accepted G1 commit. **Next stop:** G2. Both lanes are independent within this block.

### Person A

**A010 · Port ledger and payoff primitives to Solidity**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G1 · **Hand off at:** G2.

Port exact fill, endpoint/interior equity and paired delta calculations. Import frozen QMath/MathTypes from G1; return values rather than mutating storage.

**Write only:** `contracts/src/math/LedgerMath.sol`, `contracts/test/math/A/A010.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/A/A010.t.sol`.

**Required result:** Solidity matches rational reference exactly for bounded signed vectors, including no extra WAD division and terminal YES1000 atoms per lot.

**Replaces/splits:** R014, R015, R017. Full original source anchors remain in task JSON.

**A011 · Port funding budget and cushion math**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G1, A010 · **Hand off at:** G2.

Implement pure epoch rate quantization, affordable seconds, reserve/trader funding flow, clearing and cushion deltas. Keep global commit logic outside this library.

**Write only:** `contracts/src/math/FundingMath.sol`, `contracts/test/math/A/A011.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/A/A011.t.sol`.

**Required result:** Fuzz bounded reserve payer/receiver and OI changes against A005. Full common-index materialization has zero clearing/cushion; intermediate coverage slack does not decrease.

**Replaces/splits:** R027, R028, R029. Full original source anchors remain in task JSON.

**A012 · Port premium integral and tariff math**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G1, A010 · **Hand off at:** G2.

Implement pure clipped-affine integration, cumulative Q rounding, funding-stop/expiry splitting and premium-base updates against fixed epoch inputs.

**Write only:** `contracts/src/math/PremiumMath.sol`, `contracts/test/math/A/A012.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/A/A012.t.sol`.

**Required result:** Solidity is within the specified directed Q bound of the independent rational reference. Inserting neutral touches gives identical integer cumulative charge.

**Replaces/splits:** R030, R031. Full original source anchors remain in task JSON.

**A013 · Port exposure, fee and reserve math**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G1, A010 · **Hand off at:** G2.

Implement pure fee caps/cumulative allocation, order endpoint deficits, reserve slacks, concentration limit and fee-free takeover deltas.

**Write only:** `contracts/src/math/CoverageMath.sol`, `contracts/src/math/FeeMath.sol`, `contracts/test/math/A/A013.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/A/A013.t.sol`.

**Required result:** Both outcome inequalities and exact reservation-release values hold; fragmented fills stay within committed fee cap and takeover moves both cash and position.

**Replaces/splits:** R016, R025, R026, R033, R034, R055, R057. Full original source anchors remain in task JSON.

**A014 · Port settlement and capital allocation math**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G1, A010 · **Hand off at:** G2.

Port atom floors, exact Q escrow reclassification, final-share residual,20%-seed backstop bound and disabled recovery arithmetic. Outputs include every rounding owner.

**Write only:** `contracts/src/math/SettlementMath.sol`, `contracts/test/math/A/A014.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/A/A014.t.sol`.

**Required result:** Claim order cannot affect prepared amounts; fee fractions are never LP residual; recovery ratio cannot round upward or divide by zero.

**Replaces/splits:** R035, R036, R037, R066, R067, R070. Full original source anchors remain in task JSON.

**A015 · Differential-test accounting math as one engine**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G1, A011, A012, A013, A014 · **Hand off at:** G2.

Export independently calculated A-reference traces and run the pure Solidity accounting kernels through fills, funding, premium, takeover and payoff. Report exact versus bounded comparisons explicitly.

**Write only:** `contracts/test/math/A/AccountingDifferential.t.sol`, `reference/a/export_vectors.py`, `contracts/test/math/A/A015.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/A/A015.t.sol`.

**Required result:** Every ledger transition is exact in Q; premium rounding and risk-free arithmetic tolerances are enforced rather than silently widened. No storage or token dependency appears in math libraries.

**Replaces/splits:** R015, R071, R072. Full original source anchors remain in task JSON.

### Person B

**B010 · Port horizon and hazard bounds**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G1 · **Hand off at:** G2.

Implement directed horizon/volatility and hazard/tail/drift upper bounds using G1 QMath. Handle all full-backing and domain branches without external calls.

**Write only:** `contracts/src/math/HorizonMath.sol`, `contracts/src/math/HazardMath.sol`, `contracts/test/math/B/B010.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/B/B010.t.sol`.

**Required result:** Bounds enclose B003/B004 high-precision intervals and remain conservative near epsilon, T and maximum position size.

**Replaces/splits:** R018, R019, R020, R021. Full original source anchors remain in task JSON.

**B011 · Port margin and account-health math**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G1, B010 · **Hand off at:** G2.

Implement MM/IM, cap selection, explicit fullBackingRequired, health and display helpers. Account storage is not read by this library.

**Write only:** `contracts/src/math/MarginMath.sol`, `contracts/test/math/B/B011.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/B/B011.t.sol`.

**Required result:** Long/short/flat and direct-leverage vectors match B005;1x uses exact endpoints and negative equity is never used as a safety divisor.

**Replaces/splits:** R022, R023, R024. Full original source anchors remain in task JSON.

**B012 · Port certified order-risk calculations**

**Owner:** B · **Effort:** 5 points · **Dependencies:** G1, B011 · **Hand off at:** G2.

Port all-prefix marked-equity bound, monotone sign envelope and at-most64-step safe halving cap. Consume G1/G2-design coverage results through explicit values.

**Write only:** `contracts/src/math/OrderAdmissionMath.sol`, `contracts/test/math/B/B012.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/B/B012.t.sol`.

**Required result:** Every admitted small-state prefix passes reference enumeration; direct5x entry is admitted; side-flip and stale extrema remain conservative.

**Replaces/splits:** R043, R046. Full original source anchors remain in task JSON.

**B013 · Port pricing calculations**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G1, B010 · **Hand off at:** G2.

Implement interval accumulation, weighted averages, median/clamp, depth-validity calculation and beta0 rate recommendation. Signature authentication and storage ring buffers remain later tasks.

**Write only:** `contracts/src/math/PricingMath.sol`, `contracts/test/math/B/B013.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/B/B013.t.sol`.

**Required result:** Irregular samples, empty windows, stale gaps and all median orderings match B007; same timestamp cannot add elapsed price weight.

**Replaces/splits:** R039, R040, R041. Full original source anchors remain in task JSON.

**B014 · Port liquidation and clock predicates**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G1, B011 · **Hand off at:** G2.

Port reduction target/bankruptcy/pacing decisions and stage/cutoff/readiness predicates. Keep orchestration outside; encode positive-equity work exhaustion and floor-only takeovers explicitly.

**Write only:** `contracts/src/math/LiquidationMath.sol`, `contracts/src/math/LifecycleMath.sol`, `contracts/test/math/B/B014.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/B/B014.t.sol`.

**Required result:** Fee-aware candidate sizes obey B008; boundary timestamps and earlyINVALID obey B009. Takeover eligibility never depends only on requested max work.

**Replaces/splits:** R047, R048, R050, R053, R054, R056, R058. Full original source anchors remain in task JSON.

**B015 · Differential-test risk math as one engine**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G1, B012, B013, B014 · **Hand off at:** G2.

Compare pure Solidity risk/price/lifecycle results with independent high-precision B-reference outputs; verify monotonic envelopes, full-backing branches and order-prefix acceptance.

**Write only:** `contracts/test/math/B/RiskDifferential.t.sol`, `reference/b/export_vectors.py`, `contracts/test/math/B/B015.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/math/B/B015.t.sol`.

**Required result:** All required risk bounds round conservatively with documented tolerances; direct5x, short 100-versus80, boundary domains and invalid inputs pass the right accept/reject cases.

**Replaces/splits:** R023, R024, R043, R072, R073. Full original source anchors remain in task JSON.

**STOP at G2:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W3 — Build state and pricing foundations

**Start from:** the exact accepted G2 commit. **Next stop:** G3. Both lanes are independent within this block.

### Person A

**A016 · Implement isolated storage and account registry**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G2 · **Hand off at:** G3.

Store selected account/market fields, append-only1024-trader registry, separate reserve and checked epochs. Adapt frozen MathTypes through one explicit state conversion; do not edit B-owned math.

**Write only:** `contracts/src/risk/RiskStorage.sol`, `contracts/src/risk/AccountRegistry.sol`, `contracts/test/risk/A/A016.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A016.t.sol`.

**Required result:** No market aliasing or ID reuse; trader 1025 fails; zero-position cash holders remain registered. Storage-to-math conversions preserve units.

**Replaces/splits:** R004, R025. Full original source anchors remain in task JSON.

**A017 · Implement collateral custody and allocation**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G2, A016 · **Hand off at:** G3.

Implement approved-token deposit, free-balance withdrawal, market allocation and guarded release. G2 frozen admission port supplies release decisions through an A-owned scripted double until G3.

**Write only:** `contracts/src/vaults/CollateralVault.sol`, `contracts/test/risk/A/A017.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A017.t.sol`.

**Required result:** Actual received atoms equal credits; releases cannot bypass the risk decision; allocation plus free balances and escrows reconcile to custody; reentry/wrong token fails.

**Replaces/splits:** R010, R011, R012, R013. Full original source anchors remain in task JSON.

**A018 · Implement paired ledger posting and fee ledgers**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G2, A016 · **Hand off at:** G3.

Commit pure LedgerMath/FeeMath deltas to state through internal-only paired functions. Add protocol and per-beneficiary keeper Q liabilities; retain single-authority cash mutation.

**Write only:** `contracts/src/risk/Accounting.sol`, `contracts/src/risk/FeeAccounting.sol`, `contracts/test/risk/A/A018.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A018.t.sol`.

**Required result:** No public arbitrary cash/position setter; opposite legs, fees and OI update atomically; a failing second leg leaves no earlier state/log.

**Replaces/splits:** R014, R016, R057. Full original source anchors remain in task JSON.

**A019 · Implement live reserve coverage accumulator**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G2, A018 · **Hand off at:** G3.

Maintain reserve account, trader stored deficits, funding cushion and allowance as separate quantities; replace touched contributions atomically through frozen accounting port.

**Write only:** `contracts/src/risk/ReserveAccounting.sol`, `contracts/test/risk/A/A019.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A019.t.sol`.

**Required result:** Reserve position is in OI/net position but not trader deficits; both coverage inequalities hold after each posted action.

**Replaces/splits:** R025, R026, R034. Full original source anchors remain in task JSON.

**A020 · Implement locked reserve shares and backstop registry**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G2, A017, A019 · **Hand off at:** G3.

Implement preactivation1 share/atom issuance,256-holder bound, seven-day share notice, live lock/donation behavior and pre-funded per-market20%-seed backstop allocation. Final redemption execution follows W6.

**Write only:** `contracts/src/vaults/ReserveVault.sol`, `contracts/src/vaults/BackstopPool.sol`, `contracts/test/risk/A/A020.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A020.t.sol`.

**Required result:** No live mint/redeem or cross-market promised capital counts as cover; notice fixes shares, not a USDC amount.

**Replaces/splits:** R035, R036, R037. Full original source anchors remain in task JSON.

**A021 · Expose internal accounting ports and harness**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G2, A017, A018, A019, A020 · **Hand off at:** G3.

Implement the G2 internal posting/coverage/release port over real A state, with action-cutoff and version checks. Harness simulates callers without exposing production ledger setters.

**Write only:** `contracts/src/risk/AccountingPort.sol`, `contracts/test/mocks/A/MockRiskDecision.sol`, `contracts/test/harness/A/AccountingHarness.sol`, `contracts/test/risk/A/A021.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A021.t.sol`.

**Required result:** B can supply prevalidated deltas through the internal interface; unauthorized/stale permits fail. Actual storage matches the reference on deposit→allocation→paired posting.

**Replaces/splits:** R003, R005, R012, R015. Full original source anchors remain in task JSON.

### Person B

**B016 · Implement authenticated observation ingress**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G2 · **Hand off at:** G3.

Verify source identity, chain/engine domain, sequence and observed/published/accepted timestamps. Accept supplied signed payloads; external venue fetching remains CP-PRICE responsibility.

**Write only:** `contracts/src/pricing/PriceIngress.sol`, `contracts/src/interfaces/IPriceSource.sol`, `contracts/test/risk/B/B016.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B016.t.sol`.

**Required result:** Wrong domain/signer/source, duplicate/backwards sequence and future observation fail. A delayed observation does not become fresh at acceptance.

**Replaces/splits:** R008, R038. Full original source anchors remain in task JSON.

**B017 · Implement valid-window observation storage**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G2, B016 · **Hand off at:** G3.

Persist index/perp/basis cumulative integrals and coverage intervals using PricingMath. Keep separate24h INVALID capture history and bounded query/growth rules.

**Write only:** `contracts/src/pricing/ObservationStore.sol`, `contracts/test/risk/B/B017.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B017.t.sol`.

**Required result:** 300s/60s/15min windows time-weight irregular observations; stale gaps invalidate coverage; history required by INVALID is not pruned early.

**Replaces/splits:** R039. Full original source anchors remain in task JSON.

**B018 · Implement risk context and pricing bootstrap**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G2, B017 · **Hand off at:** G3.

Build immutable per-action RiskContext from current index, mark, config and time. Implement exactly-backed bootstrap and full-window normal-pricing transition at epoch opening.

**Write only:** `contracts/src/pricing/RiskPricing.sol`, `contracts/test/risk/B/B018.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B018.t.sol`.

**Required result:** Empty book can seed fully-backed depth using valid independent index. Missing normal mark never enables leveraged admission or mark liquidation.

**Replaces/splits:** R040, R041. Full original source anchors remain in task JSON.

**B019 · Implement config, authority and boundary ports**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G2 · **Hand off at:** G3.

Validate immutable listing/rules/INVALID horizon, role addresses, profile hashes and internal book/oracle ABI against G2 contract. Treat mutable calibration as versioned risk input.

**Write only:** `contracts/src/interfaces/IMarketConfig.sol`, `contracts/src/interfaces/IBookRiskHooks.sol`, `contracts/src/interfaces/IResolutionIngress.sol`, `contracts/src/risk/RiskContextPort.sol`, `contracts/test/risk/B/B019.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B019.t.sol`.

**Required result:** ExternalYES1/NO2 maps through payoff1/0 to localYES2/NO1; wrong role cannot choose outcome. No oracle callback can rewrite balances or market rules.

**Replaces/splits:** R003, R009, R024. Full original source anchors remain in task JSON.

**B020 · Build counterpart and accounting doubles**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G2, B019 · **Hand off at:** G3.

Build bounded deterministic book, resolution and scripted accounting doubles implementing the G2 contracts. Keep signatures identical to real ports; doubles supply scripted results, not a second risk engine.

**Write only:** `contracts/test/mocks/B/MockBookAdapter.sol`, `contracts/test/mocks/B/MockResolutionAuthority.sol`, `contracts/test/mocks/B/MockAccountingPort.sol`, `contracts/test/harness/B/RiskHarness.sol`, `contracts/test/risk/B/B020.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B020.t.sol`.

**Required result:** Risk/price modules compile and test independently of A state. Doubles record calls/units and fail unexpected sequencing rather than always return success.

**Replaces/splits:** R005, R008, R009. Full original source anchors remain in task JSON.

**B021 · Implement source guards and monitor restrictions**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G2, B018, B019, B020 · **Hand off at:** G3.

Track continuous fundingFreshThrough,30-second stale threshold,0.10/five-minute movement and authenticated reduce-only requests. Emit fixed context inputs without modifying A funding state directly.

**Write only:** `contracts/src/pricing/SourceGuards.sol`, `contracts/src/risk/MonitorPolicy.sol`, `contracts/test/risk/B/B021.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B021.t.sol`.

**Required result:** A late fresh observation cannot erase an old funding gap; monitor cannot settle/halt or lower hazards; missing calibration forces specified unavailable/1x mode.

**Replaces/splits:** R040, R041, R047. Full original source anchors remain in task JSON.

**STOP at G3:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W4 — Connect accrual and trading admission

**Start from:** the exact accepted G3 commit. **Next stop:** G4. Both lanes are independent within this block.

### Person A

**A022 · Integrate fixed-epoch funding into state**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G3 · **Hand off at:** G4.

Use FundingMath with current old OI, fixed epoch rate, G3 context cutoffs, budget and reserve funding. Accrue before any position mutation; initial zero OI disables the epoch.

**Write only:** `contracts/src/risk/FundingAccounting.sol`, `contracts/test/risk/A/A022.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A022.t.sol`.

**Required result:** No rate reversal/restart within epoch; budget exhaustion and stale-gap stops use authorized seconds only; reserve payer/receiver and clearing remain exact.

**Replaces/splits:** R027, R028, R029. Full original source anchors remain in task JSON.

**A023 · Integrate premium segments and surcharge state**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G3 · **Hand off at:** G4.

Persist premium origin, posted cumulative integral, epoch-paid amount and surcharge expiry. Use PremiumMath without resetting origin on neutral touch; genuine principal mutations close/reopen segments.

**Write only:** `contracts/src/risk/PremiumAccounting.sol`, `contracts/test/risk/A/A023.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A023.t.sol`.

**Required result:** Repeated neutral sync equals one delayed sync; new principal deficit renews4x while funding/premium alone does not; all premium transfers credit reserve exactly.

**Replaces/splits:** R030, R031. Full original source anchors remain in task JSON.

**A024 · Implement the authoritative account-touch sequence**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G3, A022, A023 · **Hand off at:** G4.

Combine old funding, premium, cushion retirement and stored-deficit replacement through A ports. Clear invalid reservation generations only through the agreed aggregate contract.

**Write only:** `contracts/src/risk/AccountSync.sol`, `contracts/test/risk/A/A024.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A024.t.sol`.

**Required result:** No touch double-charges or retires another account cushion; a completed common-index set has zero funding clearing and correct deficits.

**Replaces/splits:** R026, R029, R030, R033. Full original source anchors remain in task JSON.

**A025 · Implement bounded accounting rollover**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G3, A024 · **Hand off at:** G4.

Freeze cutoff/count, block all live market-ledger mutations, process at most32 traders, stage next bases and commit next epoch only when reconciliation passes. Halt can adopt the frozen work generation.

**Write only:** `contracts/src/risk/EpochRollover.sol`, `contracts/test/risk/A/A025.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A025.t.sol`.

**Required result:** Repeated/interrupted pages charge once; no market top-up/fill/release slips into a sweep; skipped hours add no accrual.

**Replaces/splits:** R032. Full original source anchors remain in task JSON.

**A026 · Compose atomic clearing actions behind the port**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G3, A024, A025 · **Hand off at:** G4.

Implement the single mutation envelope around G3 AccountingPort: old global accrual, touched account settlement, paired deltas/reservations, OI, coverage and events. Consume a B decision adapter via frozen signatures.

**Write only:** `contracts/src/risk/ClearingCore.sol`, `contracts/test/risk/A/A026.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A026.t.sol`.

**Required result:** Each successful fill checks updated mutable aggregates; injected postcondition failure rolls back all legs/logs. Prices can freeze per action but cash/OI cannot.

**Replaces/splits:** R034, R044. Full original source anchors remain in task JSON.

**A027 · Verify fee, withdrawal and conservation paths**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G3, A026 · **Hand off at:** G4.

Exercise real A clearing against a scripted B decision port, including fragmented fees, guarded releases, same-time fills and two-outcome coverage. Fix A modules only.

**Write only:** `contracts/test/risk/A/TradeAccountingInvariant.t.sol`, `contracts/test/risk/A/A027.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A027.t.sol`.

**Required result:** Fee caps cover every fragment, keeper fractions persist, and custody/zero-sum/coverage invariants hold per transaction; rejection preserves expected synchronization only.

**Replaces/splits:** R012, R016, R034, R057, R071, R075. Full original source anchors remain in task JSON.

### Person B

**B022 · Implement generation-scoped reservations**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G3 · **Hand off at:** G4.

Maintain exact bid/ask quantities, valueQ, fee commitment and conservative price extrema. Implement rest/unrest with tick, remaining fees, full epochs and generation-safe sidecars.

**Write only:** `contracts/src/risk/OrderRisk.sol`, `contracts/test/risk/B/B022.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B022.t.sol`.

**Required result:** Cancel7@400 from 7@400+11@600 leaves11 lots/value6600 atoms. Old-epoch pruning cannot subtract new reservations.

**Replaces/splits:** R042, R045. Full original source anchors remain in task JSON.

**B023 · Implement maker/taker admission decisions**

**Owner:** B · **Effort:** 5 points · **Dependencies:** G3, B022 · **Hand off at:** G4.

Use G2 OrderAdmissionMath and G3 RiskContext to issue all-prefix taker permits and re-admit each maker after the accounting port touches it. Preserve reduction-mode permissions.

**Write only:** `contracts/src/risk/OrderAdmission.sol`, `contracts/test/risk/B/B023.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B023.t.sol`.

**Required result:** Direct5x fixture completes a paired fill through the mock port; side flips, under-margin makers and coverage shortage produce specified prune/stop results before mutation.

**Replaces/splits:** R043, R044. Full original source anchors remain in task JSON.

**B024 · Implement bounded internal book adapter**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G3, B023 · **Hand off at:** G4.

Compose matcher hook calls over the frozen G3 accounting port, with at-most64 examined makers, permit release/rest conversion and no external calls in the loop.

**Write only:** `contracts/src/risk/BookRiskAdapter.sol`, `contracts/test/risk/B/B024.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B024.t.sol`.

**Required result:** Stale/self/expired makers consume steps; expected maker skip retains prior valid fills; unexpected invariant failure reverts the entire transaction. No duplicate unrest on filled size.

**Replaces/splits:** R003, R044, R045. Full original source anchors remain in task JSON.

**B025 · Implement reductions and order amendments**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G3, B024 · **Hand off at:** G4.

Apply inclusive expiry, positionVersion, cancel-all, size-down priority and cancel/replace for widened permissions. Enforce no revival after long→flat→short→long.

**Write only:** `contracts/src/risk/OrderLifecycle.sol`, `contracts/test/risk/B/B025.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B025.t.sol`.

**Required result:** Reduce-only10 against currentlong3 fills at most3 and releases7 once. Stale generation cannot affect slot reuse; crossed LIMIT remainder is dropped.

**Replaces/splits:** R042, R045. Full original source anchors remain in task JSON.

**B026 · Implement trade and release previews**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G3, B023, B025 · **Hand off at:** G4.

Return authoritative unit-tagged order/account previews using B math and G3 accounting views. Include version/cutoff and the same bootstrap/stale/sweep rejection semantics as execution.

**Write only:** `contracts/src/risk/TradePreview.sol`, `contracts/test/risk/B/B026.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B026.t.sol`.

**Required result:** Projected premium/funding is labeled; preview vs execution at the same immutable context agrees on accepted cap and required collateral.

**Replaces/splits:** R023, R046, R059. Full original source anchors remain in task JSON.

**B027 · Verify the complete book seam against a double**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G3, B024, B025, B026 · **Hand off at:** G4.

Run the specified book boundary cases through real B hooks plus scripted accounting; record exact call sequence expected from A for G4 compatibility.

**Write only:** `contracts/test/risk/B/BookSeam.t.sol`, `contracts/test/risk/B/B027.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B027.t.sol`.

**Required result:** All-prefix, mutable-aggregate, stale maker, post-only/IOC and rollback cases pass; no mock result is reported as real A integration.

**Replaces/splits:** R044, R045, R075, R076. Full original source anchors remain in task JSON.

**STOP at G4:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W5 — Build lifecycle and liquidation

**Start from:** the exact accepted G4 commit. **Next stop:** G5. Both lanes are independent within this block.

### Person A

**A028 · Implement authorized whole-account takeover**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G4 · **Hand off at:** G5.

Touch and invalidate account orders via existing ports, transfer both cash and position to reserve, zero obligations and preserve fee-free takeover. Consume B eligibility capability without choosing a mark.

**Write only:** `contracts/src/risk/TakeoverAccounting.sol`, `contracts/test/risk/A/A028.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A028.t.sol`.

**Required result:** Fresh E<=0, floor legacy deficit or both endpoints nonpositive are the only authorized routes. Positive equity plus work shortage never suffices; each outcome slack is nondecreasing.

**Replaces/splits:** R055. Full original source anchors remain in task JSON.

**A029 · Implement liquidation fee and keeper escrow posting**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G4, A028 · **Hand off at:** G5.

Post executed-close fee of one atom per lot, half reserve/half keeper in Q, including explicit reduction/waiver when full fee fails predicates. Separate withdrawal of owned keeper atoms.

**Write only:** `contracts/src/risk/LiquidationFees.sol`, `contracts/test/risk/A/A029.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A029.t.sol`.

**Required result:** No-action and takeover pay zero; an odd half-atom remains owned; keeper withdrawal cannot consume trader or reserve coverage.

**Replaces/splits:** R057. Full original source anchors remain in task JSON.

**A030 · Implement epoch-to-halt freeze handoff**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G4 · **Hand off at:** G5.

Freeze opening ledgers, fundingFQ and premium cutoff at min(halt event, active epoch end), with earlier funding stops. Expose resumable working snapshots even during rollover.

**Write only:** `contracts/src/risk/FreezeAccounting.sol`, `contracts/test/risk/A/A030.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A030.t.sol`.

**Required result:** Halt-before-first-roll and halt-during-roll produce identical legal accrual for matching cutoffs; no processing-time accrual or premature reserve snapshot finalization.

**Replaces/splits:** R058, R061, R062. Full original source anchors remain in task JSON.

**A031 · Implement floor-sweep accounting operations**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G4, A028, A030 · **Hand off at:** G5.

Provide bounded sync/reconcile/takeover operations for the B floor lifecycle, including cursor/count and no account enrollment/live mutation during the frozen sweep.

**Write only:** `contracts/src/risk/FloorAccounting.sol`, `contracts/test/risk/A/A031.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A031.t.sol`.

**Required result:** Clock alone never reports reconciled; each frozen account is visited once and every takeover maintains reserve coverage.

**Replaces/splits:** R049, R055. Full original source anchors remain in task JSON.

**A032 · Publish ledger events and reconciliation reader**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G4, A029, A030, A031 · **Hand off at:** G5.

Expose exact accounting event schema and A-side views for funding, premium, fees, takeover, vault allocation and sweep progress. Keep one canonical paired Fill emission owned by the orchestrator.

**Write only:** `contracts/src/risk/AccountingEvents.sol`, `packages/risk-sdk/src/accounting.ts`, `contracts/test/risk/A/A032.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A032.t.sol`.

**Required result:** An event replay matches stored/virtual cash with fundingClearing included; Q and atoms are never conflated and canonical fills are not counted twice.

**Replaces/splits:** R059, R060. Full original source anchors remain in task JSON.

**A033 · Verify liquidation accounting under interruption**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G4, A028, A029, A030, A031, A032 · **Hand off at:** G5.

Use scripted eligibility/book outcomes to replay partial closes, takeover, empty liquidity, fee waiver, floor sweep and early halt in every page state.

**Write only:** `contracts/test/risk/A/LiquidationAccounting.t.sol`, `contracts/test/risk/A/A033.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A033.t.sol`.

**Required result:** All cash/position invariants survive interruption; frozen cutoff and exactly-once sync hold; short caller budget cannot create a reward or confiscation.

**Replaces/splits:** R055, R057, R058, R071, R073. Full original source anchors remain in task JSON.

### Person B

**B028 · Implement derived stage and grace state**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G4 · **Hand off at:** G5.

Apply G2 LifecycleMath to time-derived stage precedence, nonrenewable grace, risk epochs, monitor restrictions and stronger halt/sweep gates.

**Write only:** `contracts/src/risk/RiskLifecycle.sol`, `contracts/test/risk/B/B028.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B028.t.sol`.

**Required result:** BelowMM has no grace; repeated touch cannot reset grace; stage restriction applies without keeper transition and bootstrap cannot override a halt.

**Replaces/splits:** R047, R048. Full original source anchors remain in task JSON.

**B029 · Implement floor reconciliation controller**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G4, B028 · **Hand off at:** G5.

Start invalidation and bounded floor generation at T−12h; coordinate G4/G5-design floor accounting port without writing cash. Halt overrides unfinished compression.

**Write only:** `contracts/src/risk/FloorLifecycle.sol`, `contracts/test/risk/B/B029.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B029.t.sol`.

**Required result:** No new exposure increases endpoint deficits; reconciled only after complete frozen list; live book calls cannot mutate a floor sweep.

**Replaces/splits:** R049. Full original source anchors remain in task JSON.

**B030 · Implement liquidation eligibility and pair selection**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G4, B028 · **Hand off at:** G5.

Authorize liquidation modes from synchronized health; cancel commitments first; validate at most one explicitly supplied opposite eligible partner at deterministic common tick.

**Write only:** `contracts/src/risk/LiquidationEligibility.sol`, `contracts/test/risk/B/B030.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B030.t.sol`.

**Required result:** Noneligible attempts do not cancel valid orders or earn rewards; both pair participants satisfy fee-aware allowed-reduction predicate before a paired posting.

**Replaces/splits:** R050, R051, R052. Full original source anchors remain in task JSON.

**B031 · Implement bounded book close and continuation**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G4, B030 · **Hand off at:** G5.

Use LiquidationMath size and bankruptcy limits to submit reduce-only IOC through the existing book adapter; enforce per-block lot pacing and examination bounds.

**Write only:** `contracts/src/risk/LiquidationBookAdapter.sol`, `contracts/test/risk/B/B031.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B031.t.sol`.

**Required result:** Actual post-fill health is recomputed; insufficient work/liquidity returns NEEDS_MORE_WORK for positive equity, retaining cover and valid remainder semantics.

**Replaces/splits:** R053, R054, R056. Full original source anchors remain in task JSON.

**B032 · Compose liquidation lifecycle and views**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G4, B029, B030, B031 · **Hand off at:** G5.

Orchestrate pair/book/takeover requests through fixed accounting ports; expose complete risk/stage/progress/rejection views without an alternative cash ledger.

**Write only:** `contracts/src/risk/RiskLiquidation.sol`, `contracts/src/risk/RiskView.sol`, `contracts/test/risk/B/B032.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B032.t.sol`.

**Required result:** Takeover request carries the exact authorized predicate/cutoff; partial reductions cannot flip side; views label unavailable prices and pending work.

**Replaces/splits:** R056, R059. Full original source anchors remain in task JSON.

**B033 · Verify lifecycle with no keeper and scarce liquidity**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G4, B032 · **Hand off at:** G5.

Warp across epochs, grace, backing floor and halt using real B controllers with scripted A ports. Test no keeper, empty book, stale mark and tiny caller budget separately.

**Write only:** `contracts/test/risk/B/LifecycleBoundaries.t.sol`, `contracts/test/risk/B/B033.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B033.t.sol`.

**Required result:** No temporal or mock shortcut bypasses coverage/gates; account registry remains frozen during sweeps; positive equity remains covered when closeout cannot finish.

**Replaces/splits:** R049, R056, R073. Full original source anchors remain in task JSON.

**STOP at G5:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W6 — Build resolution and cash settlement

**Start from:** the exact accepted G5 commit. **Next stop:** G6. Both lanes are independent within this block.

### Person A

**A034 · Implement frozen account materialization**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G5 · **Hand off at:** G6.

Process at most32 frozen participants per page from G5 freeze inputs; materialize funding/premium once into immutable working account snapshots and reserve accumulator.

**Write only:** `contracts/src/settlement/SnapshotLedger.sol`, `contracts/test/risk/A/A034.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A034.t.sol`.

**Required result:** Visited and unvisited rollover accounts reconcile at one cutoff; zero-position cash holders remain; final clearing and cushion equal zero.

**Replaces/splits:** R062. Full original source anchors remain in task JSON.

**A035 · Implement payout preparation and escrow allocation**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G5, A034 · **Hand off at:** G6.

Use SettlementMath over complete frozen snapshots and B finality/price inputs; prepare every nonnegative atom claim, exact fee escrows and reserve residual before enabling claims.

**Write only:** `contracts/src/settlement/PayoutLedger.sol`, `contracts/test/risk/A/A035.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A035.t.sol`.

**Required result:** YES/NO/INVALID totals fit assets or return RECOVERY_REQUIRED; protocol/keeper fractions are reclassified before LP residual and claim order cannot change amounts.

**Replaces/splits:** R063, R066, R070. Full original source anchors remain in task JSON.

**A036 · Implement prelisted disabled recovery calculator**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G5, A035 · **Hand off at:** G6.

Wire the pre-funded capped backstop contribution and disabled pro-rata recovery calculation to finalized deficits. Baseline recoveryEnabled=false is immutable.

**Write only:** `contracts/src/settlement/RecoveryAccounting.sol`, `contracts/test/risk/A/A036.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A036.t.sol`.

**Required result:** No live admin switch can haircut baseline claims; recovery-enabled test listings floor fixed pro-rata entitlements and handle zero total claims.

**Replaces/splits:** R037, R067. Full original source anchors remain in task JSON.

**A037 · Implement independent once-only cash claims**

**Owner:** A · **Effort:** 4 points · **Dependencies:** G5, A035, A036 · **Hand off at:** G6.

Transfer prepared trader atoms using fixed owner/recipient policy and checks-effects-interactions; retain liability for a failed transfer and prevent double claims.

**Write only:** `contracts/src/settlement/ClaimEscrow.sol`, `contracts/test/risk/A/A037.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A037.t.sol`.

**Required result:** Repeated claim has no second effect; one blocked recipient cannot block another; claims cannot start from oracleFinal alone.

**Replaces/splits:** R068. Full original source anchors remain in task JSON.

**A038 · Implement terminal reserve and fee release**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G5, A037 · **Hand off at:** G6.

Pay matured-notice reserve shares against frozen final denominator only after all other entitlements are escrowed. Preserve unclaimed trader/fee liabilities and classify every fraction/dust.

**Write only:** `contracts/src/settlement/ReserveClaims.sol`, `contracts/test/risk/A/A038.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A038.t.sol`.

**Required result:** LP redemption before trader/keeper clicks claim is safe; no final-redeemer windfall and no live-share path unlocks early.

**Replaces/splits:** R036, R070. Full original source anchors remain in task JSON.

**A039 · Verify payout batches and custody conservation**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G5, A034, A035, A036, A037, A038 · **Hand off at:** G6.

Run real A frozen-ledger/claim modules against scripted B finality. Permute page sizes, interruptions, outcome prices and claim/redemption order.

**Write only:** `contracts/test/risk/A/SettlementConservation.t.sol`, `contracts/test/risk/A/A039.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/A/A039.t.sol`.

**Required result:** Cash+fee+keeper+reserve classifications reconcile exactly in Q; individual external transfers floor only at their stated boundary and retries never duplicate amounts.

**Replaces/splits:** R063, R066, R068, R070, R071. Full original source anchors remain in task JSON.

### Person B

**B034 · Implement authenticated immutable finality ingress**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G5 · **Hand off at:** G6.

Accept only configured ResolutionOracle halt/settle0/1/INVALID calls, materialize scheduled halt permissionlessly and latch once-only outcome in constant bounded work.

**Write only:** `contracts/src/settlement/ResolutionIngress.sol`, `contracts/test/risk/B/B034.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B034.t.sol`.

**Required result:** Unauthorized actors and conflicting finality fail; repeated same outcome is idempotent; oracle Final transition cannot silently drop a failed engine delivery.

**Replaces/splits:** R009, R061, R064. Full original source anchors remain in task JSON.

**B035 · Implement deterministic INVALID capture**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G5, B034 · **Hand off at:** G6.

Use G3 independent observation history for the immutable preT24h interval; earlyINVALID waits. Capture complete data once or disclosed.5 fallback only after T+1h.

**Write only:** `contracts/src/settlement/InvalidPrice.sol`, `contracts/test/risk/B/B035.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B035.t.sol`.

**Required result:** No post-halt sample resumes risk/funding; incomplete windows never silently replace the listed rule; listing horizon and capture-boundary cases are exact.

**Replaces/splits:** R065. Full original source anchors remain in task JSON.

**B036 · Implement snapshot and preparation controller**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G5, B034, B035 · **Hand off at:** G6.

Drive frozen snapshot and payout cursors through G5-defined A settlement ports; distinguish finality accepted, price pending, preparing, claims-ready and complete.

**Write only:** `contracts/src/settlement/SettlementController.sol`, `contracts/test/risk/B/B036.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B036.t.sol`.

**Required result:** Callbacks perform no account loop/token transfer; jobs retry after interruption; claims-ready requires complete reconciled liabilities rather than oracle status alone.

**Replaces/splits:** R061, R063, R066. Full original source anchors remain in task JSON.

**B037 · Publish oracle-team compatibility fixture**

**Owner:** B · **Effort:** 4 points · **Dependencies:** G5, B036 · **Hand off at:** G6.

Exercise exact halt tuple/OI units, external/local enum mapping, scheduled/early clocks and oracle-delivery retries using the external team interface and mock authority.

**Write only:** `contracts/test/risk/B/OracleCompatibility.t.sol`, `docs/counterpart-oracle-fixtures.json`, `contracts/test/risk/B/B037.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B037.t.sol`.

**Required result:** OI includes reserve and lots convert explicitly to bond exposure; accepted binary resolution need not wait forT; INVALID remains pending as required.

**Replaces/splits:** R009, R064, R065, R076. Full original source anchors remain in task JSON.

**B038 · Fence conversion and publish settlement read model**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G5, B036 · **Hand off at:** G6.

Keep optional token conversion disabled; encode mutually exclusive future cash/token claims and full-backing prerequisite. Decode state/views into explicit pending/claimable status.

**Write only:** `contracts/src/settlement/ConversionGate.sol`, `packages/risk-sdk/src/settlement.ts`, `contracts/test/risk/B/B038.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B038.t.sol`.

**Required result:** No token path can activate after a cash claim or with underbacking; UI never presents oracleFinal as claimable without readiness.

**Replaces/splits:** R069, R078. Full original source anchors remain in task JSON.

**B039 · Verify the resolution-to-claim lifecycle**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G5, B037, B038 · **Hand off at:** G6.

Exercise real B ingress/capture/controller using scripted A snapshots and claims. Include halt during rollover, delayed windows, stale history and duplicate delivery.

**Write only:** `contracts/test/risk/B/SettlementLifecycle.t.sol`, `contracts/test/risk/B/B039.t.sol`.

**Acceptance command:** `cd contracts && forge test --match-path test/risk/B/B039.t.sol`.

**Required result:** Every branch has a deterministic next action/status; no conflicting cutoff, replay or transient preparation issue changes the latched outcome.

**Replaces/splits:** R061, R064, R065, R069, R073, R074. Full original source anchors remain in task JSON.

**STOP at G6:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.

## W7 — Verify and hand off the integrated system

**Start from:** the exact accepted G6 commit. **Next stop:** G7. Both lanes are independent within this block.

### Person A

**A040 · Run integrated accounting invariant campaign**

**Owner:** A · **Effort:** 5 points · **Dependencies:** G6 · **Hand off at:** G7.

Run real integrated modules from G6 through adversarial deposits/fills/funding/premium/liquidation/claim sequences against independent rational transitions.

**Write only:** `contracts/test/invariant/A/AccountingInvariants.t.sol`, `reference/a/integrated_traces.py`, `artifacts/acceptance/A040.json`.

**Acceptance command:** `bash scripts/check-task.sh A040`.

**Required result:** Zero-sum positions, custody, both reserve sides, clearing and immutable entitlements hold after every successful mutation. Report seeds and minimized failing traces.

**Replaces/splits:** R071, R072, R075. Full original source anchors remain in task JSON.

**A041 · Measure accounting and sweep gas bounds**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G6, A040 · **Hand off at:** G7.

Measure math, premium-touch,1024-account/32-page rollover, snapshot and claim costs using pinned local/testnet gas model; do not infer network ceilings from an unverified mode.

**Write only:** `contracts/test/gas/A/AccountingGas.t.sol`, `artifacts/risk/gas-accounting.json`, `artifacts/acceptance/A041.json`.

**Acceptance command:** `bash scripts/check-task.sh A041`.

**Required result:** Report worst measured counts/limits and failure behavior at bounds. Ledger sweeps remain resumable at proposed deployment transaction limits.

**Replaces/splits:** R077. Full original source anchors remain in task JSON.

**A042 · Reconcile token custody and capital exit**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G6, A040 · **Hand off at:** G7.

Run end-to-end cash and fee escrow exits including partial keeper withdrawals, unclaimed users, LP notices, donations and backstop limits.

**Write only:** `contracts/test/integration/A/CustodyExit.t.sol`, `artifacts/risk/custody-reconciliation.json`, `artifacts/acceptance/A042.json`.

**Acceptance command:** `bash scripts/check-task.sh A042`.

**Required result:** Every Q liability remains recognized after LP exit; prohibited token behavior fails safely and no market borrows another market allocation.

**Replaces/splits:** R010, R013, R037, R068, R070, R074. Full original source anchors remain in task JSON.

**A043 · Review B decision and callback boundaries**

**Owner:** A · **Effort:** 3 points · **Dependencies:** G6, A040 · **Hand off at:** G7.

Review B margin/admission predicates, cutoff selection, finality authorization and status-to-claim gates. Write concrete findings/reproducers; B remains the editor for B files.

**Write only:** `artifacts/reviews/A-on-B.md`, `artifacts/acceptance/A043.json`.

**Acceptance command:** `bash scripts/check-task.sh A043`.

**Required result:** No open critical finding in reviewed decisions; each fix links B task/commit and rerun. Cross-review is not represented as an external audit.

**Replaces/splits:** R079. Full original source anchors remain in task JSON.

**A044 · Publish accounting handoff evidence**

**Owner:** A · **Effort:** 2 points · **Dependencies:** G6, A041, A042, A043 · **Hand off at:** G7.

Record accounting module/fixture hashes, actual commands, gas model, escrow and invariant status, and startup/rollover/claim operational steps.

**Write only:** `artifacts/risk/accounting-release.json`, `docs/runbooks/accounting.md`, `artifacts/acceptance/A044.json`.

**Acceptance command:** `bash scripts/check-task.sh A044`.

**Required result:** Manifest has no invented tests, addresses or deployment success; baseline1x/funding-off/recovery-off flags stay explicit until applicable release gates pass.

**Replaces/splits:** R080. Full original source anchors remain in task JSON.

### Person B

**B040 · Run integrated lifecycle and counterpart campaign**

**Owner:** B · **Effort:** 5 points · **Dependencies:** G6 · **Hand off at:** G7.

Run real G6 engine through bootstrap, leveraged local fixture, stale maker, no keeper, liquidation, early/scheduled halt and all payoff modes. Connect real CP contracts when available; otherwise retain explicit mock status.

**Write only:** `contracts/test/integration/B/FullLifecycle.t.sol`, `artifacts/risk/counterpart-status.json`, `artifacts/acceptance/B040.json`.

**Acceptance command:** `bash scripts/check-task.sh B040`.

**Required result:** Real and mocked counterparts pass the same versioned ABI fixtures; absent real book/oracle is reported blocked for live join, not replaced with a false pass.

**Replaces/splits:** R073, R074, R075, R076. Full original source anchors remain in task JSON.

**B041 · Measure pricing and matching bounds**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G6, B040 · **Hand off at:** G7.

Measure observation updates,64-node dirty-book traversal, liquidation continuation, oracle callback and settlement-controller costs at configured bounds.

**Write only:** `contracts/test/gas/B/AdapterGas.t.sol`, `artifacts/risk/gas-adapters.json`, `artifacts/acceptance/B041.json`.

**Acceptance command:** `bash scripts/check-task.sh B041`.

**Required result:** Invalid/stale/self nodes count against work limit; callback is independent of participant count; no unbounded observation/account iteration enters matching.

**Replaces/splits:** R077. Full original source anchors remain in task JSON.

**B042 · Publish SDK views and frontend fixtures**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G6, B040 · **Hand off at:** G7.

Combine frozen A accounting fields with B risk/settlement decoders in a read-only SDK. Provide every frontend state and unit with block/config/price/cutoff identity.

**Write only:** `packages/risk-sdk/src/index.ts`, `packages/risk-sdk/test/read-model.test.ts`, `docs/app-state-fixtures.json`, `artifacts/acceptance/B042.json`.

**Acceptance command:** `bash scripts/check-task.sh B042`.

**Required result:** SDK reproduces authoritative values and pending labels; unavailable is not zero, projections are not withdrawable amounts, and no SDK-side balance is authoritative.

**Replaces/splits:** R059, R060, R078. Full original source anchors remain in task JSON.

**B043 · Review A cash and reserve transitions**

**Owner:** B · **Effort:** 3 points · **Dependencies:** G6, B040 · **Hand off at:** G7.

Review A units, cash mutations, funding cushion, premium rounding, escrow allocation and capital exits. Write concrete reproducers; A fixes A-owned files.

**Write only:** `artifacts/reviews/B-on-A.md`, `artifacts/acceptance/B043.json`.

**Acceptance command:** `bash scripts/check-task.sh B043`.

**Required result:** Every cash-changing route and protected liability has a review result; no open critical defect and each accepted fix has a rerun record.

**Replaces/splits:** R079. Full original source anchors remain in task JSON.

**B044 · Publish integration handoff evidence**

**Owner:** B · **Effort:** 2 points · **Dependencies:** G6, B041, B042, B043 · **Hand off at:** G7.

Record external interface versions, real/mock status, keeper jobs, pending-state runbooks, disabled features and complete source/task migration links.

**Write only:** `artifacts/risk/integration-release.json`, `docs/runbooks/lifecycle.md`, `artifacts/acceptance/B044.json`.

**Acceptance command:** `bash scripts/check-task.sh B044`.

**Required result:** Another developer can replay local lifecycle and identify every blocked live integration; no production deploy is implied by the document.

**Replaces/splits:** R080. Full original source anchors remain in task JSON.

**STOP at G7:** merge both lanes, run the combined acceptance above, record the real passing commit, and both pull it before dependent work.
