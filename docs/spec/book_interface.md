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
    bool removeMakerRemainder;
}
```

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
| Partial reduce-only | Reduce-only sell10; position independently shrinks long10→long3 | Fill at most3, remove7, flat without short flip; release quantities exactly once |
| Reduce-only revival | long→flat→short→flat→long between admission and encounter | Old order invalid due positionVersion even though current sign again matches |
| Taker reserve prefix | Requested taker crosses through zero into opposite-side cap | Permit covers every accepted prefix or conservatively clips before unsafe branch |
| Worst-limit improvement | Buy permit at650 executes610 then620 | Better fills cannot consume more notional than reserved limit; fees remain within cap |
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
| Direct 5x entry | Validated scheduled fixture below: flat account buys1000claims atmark.60 with120USDC and funded reserve | Admission and bilateral fill succeed; long NO deficit480USDC is covered, displayed leverage5x |
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

- `qWad = indexWad = 0.60*Q`, fill/limit tick600; 1,000claims =1,000,000lots; zero trading fee; no elapsed premium/funding; live stage; no old orders or stale epochs.
- Scheduled template cap5; time remaining29days; `h0=5min`, absorption1000claims/min gives `h=6min`; both hazards0.01%/day; `epsilon=.01`, `gamma=1.5`, `s=.005`, `lambda=1e-6/claim`. Use monotone upper-envelope kernel. The linear hazard bound is4.1666666667e-7, `sigma=sqrt(.24*360/2505600)=.005872202195`; the Cantelli multiplier is about9.95008. Thus MM is about63.929058USDC and gammaMM about95.893587USDC; the cap branch makes IM=600/5=120USDC.
- Taker is initially flat with `cashQ=120_000_000*Q`. Temporary bid reserves `Vb=600_000_000*Q`; `maxBidTick=600`, so the marked adverse-fill deduction is zero. `Emin=120_000_000*Q`, and the long1000claim IM envelope is120USDC. The old rectangle would wrongly show−480USDC; the selected rule passes.
- Maker is flat, deposits400USDC and rests an ask for1000claims at600. Its fully-backed short-side commitment passes both outcome checks. The reserve starts with100,000USDC cash, no position, funding allowance0; per-account deficit cap2% gives2,000USDC, above the taker's480USDC worst deficit.
- After fill: taker `x=+1_000_000lots`, `cashQ=−480_000_000*Q`, mark equity120USDC, outcome valuesNO=−480/YES=520USDC, leverage600/120=5. Maker `x=−1_000_000lots`, `cashQ=1_000_000_000*Q`, equity400USDC, outcomesNO=1000/YES=0USDC. Trader cash still totals520USDC, positions net tozero; reserve has enough for NO480 and YES0 separately. Every stored and emitted amount uses exact cashQ.
- Test the entire path: admission, temporary coverage reservation, maker touch/readmission, paired fill, book debit, permit release, and final invariant check. Assert the request is not merely admitted then stopped before fill. Run smaller partial-fill prefixes and two-maker fragmentation too. A separate fixture with reserve below required NO cover must fail, despite the same valid margin calculation.

**Fixture calculation checked during document preparation:** numerical enumeration of all 1,000,000 one-lot prefixes found maximum IM120USDC; exact integer ledger arithmetic at tick600 found NO deficit no greater than480USDC and YES deficit zero for every prefix. This validates the worked fixture, not the yet-to-be-built production book or a general monotonicity proof. The integration tests above remain required.
