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
