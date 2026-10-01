// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ConversionGate} from "../settlement/ConversionGate.sol";
import {ReserveClaims} from "../settlement/ReserveClaims.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {AccountingState, PricingMode, RejectCode} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {CoverageMath as C} from "../math/CoverageMath.sol";
import {FundingMath as F} from "../math/FundingMath.sol";
import {PremiumMath as P} from "../math/PremiumMath.sol";
import {QMath} from "../math/QMath.sol";

/// @title RiskAccountingBridge
/// @notice Integration composition of the Risk & Clearing layer: Person B's controllers
///         (ConversionGate and everything below it) on Person A's accounting, custody and
///         settlement modules (ReserveClaims and everything below it), in one contract.
/// @dev Owner: integration (A + B review). This file only translates calls:
///      - B's `IAccountingPort` (`_acct*`) is implemented by calling A's internal functions. Every
///        cash/position/fee/reserve movement happens inside an A function; the bridge never sets a
///        balance itself.
///      - A's decision/context ports (`_riskContext`, `_riskAccept`) are answered by B. B decides
///        trading, liquidation and takeover actions before asking A to post them, so the bridge
///        authorizes exactly the posting it is about to request (transient per-call authorization);
///        releases are decided by B's guarded release decision on A's request.
///      Trader ids: id = A registry index + 1. Mapping and every reconciliation choice are listed in
///      docs/merge/interface-reconciliation.md.
abstract contract RiskAccountingBridge is ConversionGate, ReserveClaims {
    error UnknownTrader(uint32 id);

    /// @dev Per-call authorization for A's `_riskAccept` (cleared after each posting).
    uint8 private transient _authKind;
    address private transient _authA;
    address private transient _authB;
    uint256 private transient _authFeeA;
    uint256 private transient _authFeeB;

    uint8 private constant AUTH_NONE = 0;
    uint8 private constant AUTH_TRADE = 1;
    uint8 private constant AUTH_TAKEOVER = 2;
    uint8 private constant AUTH_LIQUIDATION = 3;
    uint8 private constant AUTH_RESERVATION = 4;

    /// @dev Premium load (spec §4.1 local profile: 1). Engine configuration, manifest-supplied.
    uint256 internal immutable _premiumLoadWad;

    mapping(address => uint32) internal _idOf;

    constructor(uint256 premiumLoadWad) {
        _premiumLoadWad = premiumLoadWad;
    }

    // ================================================================ id mapping

    function _addr(uint32 id) internal view returns (address) {
        if (id == 0 || id > participants.length) revert UnknownTrader(id);
        return participants[id - 1];
    }

    function _remember(uint32 id, address who) internal {
        if (_idOf[who] == 0) _idOf[who] = id;
    }

    /// @notice Engine trader id of an allocated account (0 if never seen by B; see traderIdAt).
    function traderIdOf(address owner) external view returns (uint32) {
        return _idOf[owner];
    }

    /// @notice Engine trader id = registry index + 1.
    function traderIdAt(uint256 index) external view returns (uint32 id, address owner) {
        owner = participants[index];
        id = uint32(index + 1);
    }

    // ================================================================ helpers

    function _orders(OA.OrderSums memory s) internal pure returns (C.Orders memory o) {
        o = C.Orders(s.bidLots, s.bidValueQ, s.askLots, s.askValueQ, s.feeCapQ);
    }

    function _sameOrders(C.Orders memory a, C.Orders memory b) internal pure returns (bool) {
        return a.bidLots == b.bidLots && a.bidValueQ == b.bidValueQ && a.askLots == b.askLots
            && a.askValueQ == b.askValueQ && a.feeCapQ == b.feeCapQ;
    }

    /// @dev The legal economic cutoff for touches in the current accounting state.
    function _bridgeCutoff() internal view returns (uint64) {
        if (work != Work.READY) return sweepCutoff;
        uint64 nowTs = _clock();
        return nowTs < epoch.end ? nowTs : epoch.end;
    }

    function _liveForAccounting() internal view returns (bool) {
        return active && !halted && work == Work.READY;
    }

    function _authorize(uint8 kind, address a, address b, uint256 feeA, uint256 feeB) private {
        (_authKind, _authA, _authB, _authFeeA, _authFeeB) = (kind, a, b, feeA, feeB);
    }

    function _clearAuth() private {
        _authorize(AUTH_NONE, address(0), address(0), 0, 0);
    }

    // ================================================================ A -> B ports

    /// @dev A's per-action context from B's frozen pricing context (same block, same versions).
    function _riskContext() internal view virtual override returns (Context memory c) {
        RiskContext memory r = _pricingContext();
        c.at = _clock();
        // A uses one field for funding stop and mark freshness. Funding gaps are applied first by
        // `_acctBeginAction` / `_onFreshnessAdvance` (which stop the epoch permanently), so a
        // valid normal mark is reported fresh through `now` (R-04).
        c.freshThrough = r.markOk ? c.at : r.fundingFreshThrough;
        c.version = r.riskVersion;
        c.markAvailable = r.markOk;
        c.markWad = r.markOk ? r.markWad : 0;
    }

    function _riskAccept(Decision memory d) internal view virtual override returns (bool) {
        if (d.kind == ActionKind.RELEASE) return _acceptRelease(d);
        if (d.kind == ActionKind.TRADE) {
            return _authKind == AUTH_TRADE
                && ((d.owner == _authA && d.counterparty == _authB) || (d.owner == _authB && d.counterparty == _authA));
        }
        if (d.kind == ActionKind.TAKEOVER) return _authKind == AUTH_TAKEOVER && d.owner == _authA;
        if (d.kind == ActionKind.LIQUIDATION) {
            if (_authKind != AUTH_LIQUIDATION) return false;
            if (d.owner == _authA) return d.feesQ <= _authFeeA;
            if (d.owner == _authB) return d.feesQ <= _authFeeB;
            return false;
        }
        if (d.kind == ActionKind.RESERVATION) return _authKind == AUTH_RESERVATION && d.owner == _authA;
        return false; // RESERVE_UNWIND: no B path in v1
    }

    /// @dev Guarded release (spec §2.3): B's release decision over A's post-release state.
    function _acceptRelease(Decision memory d) internal view returns (bool ok) {
        uint32 id = _idOf[d.owner];
        OA.OrderSums memory s = id == 0 ? _conservativeSums(d.afterOrders) : _resSums(id);
        int256 dCash = d.afterValue.cashQ - d.beforeValue.cashQ;
        OA.CoverageInput memory cov = _coverageFor(d.owner, s, dCash, 0);
        (ok,) = _riskReleaseDecision(ReleaseInput(d.afterValue.cashQ, d.afterValue.lots, s, cov));
    }

    /// @dev An account B never touched has no B reservations; if A holds orders for it anyway,
    ///      assume the worst price extrema (bids at 999, asks at 1) so the decision stays conservative.
    function _conservativeSums(C.Orders memory o) internal pure returns (OA.OrderSums memory s) {
        s = OA.emptySums();
        (s.bidLots, s.bidValueQ, s.askLots, s.askValueQ, s.feeCapQ) =
            (o.bidLots, o.bidValueQ, o.askLots, o.askValueQ, o.feeCapQ);
        if (o.bidLots != 0) s.maxBidTick = 999;
        if (o.askLots != 0) s.minAskTick = 1;
    }

    /// @dev B021 hook: accrue/stop old-epoch funding against the previous continuous-freshness
    ///      endpoint before a new observation moves it (spec §3.1).
    function _onFreshnessAdvance(uint64 oldFreshThrough) internal virtual override {
        if (_liveForAccounting() && !epoch.stopped && _clock() < epoch.end) {
            _advanceFunding(_clock(), oldFreshThrough);
        }
    }

    // ================================================================ B -> A: trading

    function _acctBeginAction() internal virtual override returns (AccrualView memory v) {
        if (_liveForAccounting() && _clock() < epoch.end) {
            _advanceFunding(_clock(), _pricingContext().fundingFreshThrough);
        }
        v.cutoff = _bridgeCutoff();
        v.accountingEpochId = epoch.id;
        v.fundingIndex = fundingFQ;
        v.state = _acctAccountingState();
        v.premiumTariffHash = keccak256(abi.encode(tariff));
        v.marketOrderEpoch = marketOrderEpoch;
    }

    function _acctTouch(uint32 trader) internal virtual override {
        address who = _addr(trader);
        _remember(trader, who);
        if (!active) return; // nothing accrues before activation
        _touch(who, _bridgeCutoff());
    }

    function _acctAccount(uint32 trader) internal view virtual override returns (AccountView memory v) {
        if (trader == 0 || trader > participants.length) return v;
        Account storage a = accounts[participants[trader - 1]];
        v.cashQ = a.value.cashQ;
        v.lots = a.value.lots;
        v.orderEpoch = a.orderEpoch;
        v.positionVersion = a.positionVersion;
        v.registered = true;
    }

    function _acctCoverage(uint32 trader, OA.OrderSums memory sums, int256 dCashQ, int256 dLots)
        internal
        view
        virtual
        override
        returns (OA.CoverageInput memory)
    {
        return _coverageFor(_addr(trader), sums, dCashQ, dLots);
    }

    /// @dev A's order-aware deficits (CoverageMath) for the hypothetical account, the 2% cap of
    ///      A's immutable reserveCapBaseQ, and both reserve inequalities after replacing only this
    ///      account's stored contribution.
    function _coverageFor(address who, OA.OrderSums memory sums, int256 dCashQ, int256 dLots)
        internal
        view
        returns (OA.CoverageInput memory cov)
    {
        Account storage a = accounts[who];
        L.Value memory v = L.Value(QMath.position(int256(a.value.lots) + dLots), QMath.cash(a.value.cashQ + dCashQ));
        (cov.d0Q, cov.d1Q) = C.deficits(v, _orders(sums));
        cov.deficitCapQ = reserveCapBaseQ / 50;
        (int256 s0, int256 s1) = coverageSlacks();
        s0 = s0 + QMath.signed(a.deficit0) - QMath.signed(cov.d0Q);
        s1 = s1 + QMath.signed(a.deficit1) - QMath.signed(cov.d1Q);
        cov.marketOk = s0 >= 0 && s1 >= 0;
    }

    /// @dev Replace the account's stored order contribution through A's reservation port
    ///      (A026 `_setReservations`: touch, decision, replace, coverage assertion). Unchanged
    ///      aggregates are a no-op, so stale-epoch syncs after A already cleared orders cost nothing.
    function _acctReplaceContribution(uint32 trader, OA.OrderSums memory sums) internal virtual override {
        address who = _addr(trader);
        _remember(trader, who);
        C.Orders memory next = _orders(sums);
        Account storage a = accounts[who];
        if (_sameOrders(a.orders, next) && a.reservationMarketEpoch == marketOrderEpoch) return;
        _authorize(AUTH_RESERVATION, who, address(0), 0, 0);
        _setReservations(who, next, a.orderEpoch, _checkedContext());
        _clearAuth();
    }

    function _acctPostFill(FillDelta memory d) internal virtual override {
        (address buyer, address seller, uint256 bFee, uint256 sFee) = _sides(d);
        _authorize(AUTH_TRADE, buyer, seller, 0, 0);
        _pairedFill(
            PairInput(buyer, seller, d.lots, d.tick, bFee, sFee, accounts[buyer].orders, accounts[seller].orders),
            _checkedContext()
        );
        _clearAuth();
    }

    function _sides(FillDelta memory d)
        internal
        view
        returns (address buyer, address seller, uint256 bFee, uint256 sFee)
    {
        address maker = _addr(d.maker);
        address taker = _addr(d.taker);
        (buyer, seller) = d.takerBuys ? (taker, maker) : (maker, taker);
        (bFee, sFee) = d.takerBuys ? (d.takerFeeQ, d.makerFeeQ) : (d.makerFeeQ, d.takerFeeQ);
    }

    /// @dev Spec §4.6 AccountingState. A's `Work` has the same ordinals; an ended epoch whose
    ///      rollover has not begun is reported as ROLLOVER_SWEEP (spec §5.7: "any call derives
    ///      AccountingRollover"). Before activation no accounting epoch exists, also reported as
    ///      ROLLOVER_SWEEP so B rejects trading (R-03).
    function _acctAccountingState() internal view virtual override returns (AccountingState) {
        if (!active) return AccountingState.ROLLOVER_SWEEP;
        if (work == Work.READY && !halted && _clock() >= epoch.end) return AccountingState.ROLLOVER_SWEEP;
        return AccountingState(uint8(work));
    }

    function _acctBumpAccountOrderEpoch(uint32 trader) internal virtual override returns (uint64) {
        address who = _addr(trader);
        _cancelReservations(who);
        return accounts[who].orderEpoch;
    }

    /// @dev A exposes no standalone market-epoch bump (it bumps inside rollover/floor/freeze);
    ///      A's touch clears stale reservations lazily by comparing this counter (R-06).
    function _acctBumpMarketOrderEpoch() internal virtual override returns (uint64) {
        return ++marketOrderEpoch;
    }

    function _acctMarketOrderEpoch() internal view virtual override returns (uint64) {
        return marketOrderEpoch;
    }

    /// @dev View-only projection for previews: funding at the epoch's fixed rate limited by the
    ///      remaining budget and stops, plus A's cumulative premium formula. Never an authorization.
    function _acctProjectedAccrual(uint32 trader, uint64 atTime)
        internal
        view
        virtual
        override
        returns (int256 fundingQ, uint256 premiumQ)
    {
        if (!active || trader == 0 || trader > participants.length) return (0, 0);
        Account storage a = accounts[participants[trader - 1]];
        uint64 until = atTime < epoch.end ? atTime : epoch.end;
        int256 fIndex = fundingFQ;
        if (!epoch.stopped && until > epoch.last && !halted) {
            uint64 cut = until;
            uint64 fresh = _pricingContext().fundingFreshThrough;
            if (cut > fresh) cut = fresh;
            uint64 floorTime = scheduledT - 12 hours;
            if (cut > floorTime) cut = floorTime;
            if (cut > epoch.last) {
                F.Delta memory fd = F.advance(cut - epoch.last, epoch.rate, oiAllLots, reserve.lots, fundingBudgetQ);
                fIndex += fd.indexQ;
            }
        }
        fundingQ = int256(a.value.lots) * (fIndex - a.fundingCheckpoint);
        if (work == Work.READY && !halted && until > a.lastTouchedAt) {
            uint256 total = _premiumTotal(a, until);
            premiumQ = total > a.segmentPosted ? total - a.segmentPosted : 0;
        }
    }

    // ================================================================ B -> A: liquidation

    function _acctTakeover(TakeoverAuth memory auth) internal virtual override {
        address who = _addr(auth.trader);
        _authorize(AUTH_TAKEOVER, who, address(0), 0, 0);
        _takeover(who, _checkedContext());
        _clearAuth();
    }

    function _acctPostLiquidationFill(FillDelta memory d, uint256 allowedFeeQ, address keeper)
        internal
        virtual
        override
        returns (uint256 charged)
    {
        address target = _addr(d.taker);
        L.Value memory beforeValue = accounts[target].value;
        uint64 beforeVersion = accounts[target].positionVersion;
        _acctPostFill(FillDelta(d.maker, d.taker, d.takerBuys, d.lots, d.tick, d.makerFeeQ, 0));
        if (allowedFeeQ == 0) return 0;
        _authorize(AUTH_LIQUIDATION, target, address(0), allowedFeeQ, 0);
        charged = _chargeCloseFee(target, beforeValue, beforeVersion, d.lots, keeper, _checkedContext());
        _clearAuth();
    }

    function _acctPostPairLiquidation(FillDelta memory d, address keeper)
        internal
        virtual
        override
        returns (uint256 charged)
    {
        (address buyer, address seller, uint256 bFee, uint256 sFee) = _sides(d);
        C.Orders memory none;
        _authorize(AUTH_LIQUIDATION, buyer, seller, bFee, sFee);
        charged =
            _liquidationPair(PairInput(buyer, seller, d.lots, d.tick, 0, 0, none, none), keeper, _checkedContext());
        _clearAuth();
    }

    function _acctFloorBegin() internal virtual override returns (uint64) {
        _beginFloor(_checkedContext());
        return uint64(sweepCount);
    }

    function _acctFloorPage(uint256 maxAccounts)
        internal
        virtual
        override
        returns (JobProgress memory p, uint64 takeovers)
    {
        if (maxAccounts == 0 || maxAccounts > 32) revert BadState();
        uint256 start = cursor;
        uint256 end = start + maxAccounts < sweepCount ? start + maxAccounts : sweepCount;
        uint64[32] memory versions;
        for (uint256 i = start; i < end; ++i) {
            versions[i - start] = accounts[participants[i]].positionVersion;
        }
        bool complete = _floorPage(uint8(maxAccounts));
        // A's takeover is the only floor-page step that bumps an account's position version.
        for (uint256 i = start; i < end; ++i) {
            if (accounts[participants[i]].positionVersion != versions[i - start]) ++takeovers;
        }
        p = JobProgress(uint64(cursor), uint64(sweepCount), complete);
    }

    function _acctAccountCount() internal view virtual override returns (uint64) {
        return uint64(participants.length);
    }

    // ================================================================ B -> A: settlement

    function _acctFreeze(uint64 economicHaltAt_, uint64)
        internal
        virtual
        override
        returns (FreezeResult memory f)
    {
        Work before = work;
        _freeze(economicHaltAt_, _pricingContext().fundingFreshThrough);
        f.frozenAccountCount = uint64(sweepCount);
        f.frozenBookEpoch = marketOrderEpoch;
        f.oiHaltLots = oiHaltLots;
        f.fundingIndexAtHalt = fundingFQ;
        f.accountingEpochAtHalt = epoch.id;
        f.accrualCutoff = accrualCutoff;
        f.premiumTariffHash = keccak256(abi.encode(tariff));
        f.frozenAccountingState = keccak256(abi.encode(uint8(before), sweepCount, generation));
    }

    function _acctEpochBounds() internal view virtual override returns (uint64 end, uint64 frozenRollover) {
        end = epoch.end;
        frozenRollover = work == Work.ROLLOVER_SWEEP ? sweepCutoff : 0;
    }

    function _acctPrepareSnapshotChunk(uint256 maxAccounts) internal virtual override returns (JobProgress memory p) {
        bool done = _snapshotPage(uint8(maxAccounts));
        p = JobProgress(uint64(cursor), uint64(sweepCount), done);
    }

    function _acctPreparePayoutChunk(uint256 maxAccounts, MathTypes.FinalOutcome outcome, uint256 priceWad)
        internal
        virtual
        override
        returns (JobProgress memory p)
    {
        _acceptSettlementPrice(priceWad, keccak256(abi.encode(_halt.snapshotId, outcome, priceWad)));
        if (!payoutScanComplete) {
            _scanPayoutPage(uint8(maxAccounts));
        } else if (!recoveryRequired) {
            _allocatePayoutPage(uint8(maxAccounts));
        }
        bool done = payoutsAllocated || (payoutScanComplete && recoveryRequired);
        p = JobProgress(uint64(payoutCursor + allocationCursor), uint64(2 * sweepCount), done);
    }

    function _acctFinishPreparation() internal virtual override returns (FinishResult memory r) {
        if (recoveryRequired && !useRecovery) {
            r.recoveryRequired = true;
            return r;
        }
        // Reserve shareholder registry is bounded at 256 (8 pages of 32).
        while (!claimsEnabled) _prepareReservePage(32);
        r.claimsEnabled = true;
        r.totalTraderPayoutAtoms = totalTraderAtoms;
        r.reserveContributionAtoms = 0;
    }

    /// @dev A037 exposes no aggregate "all claimed" counter; COMPLETE is not reported (R-10).
    function _acctClaimsComplete() internal view virtual override returns (bool) {
        return false;
    }

    /// @dev Conservative: once claims are enabled a cash claim may have been paid (A037 has no
    ///      flag and its claim path has no B hook), so conversion can never start (DEC-10 keeps
    ///      conversion disabled anyway; R-11).
    function _acctAnyCashClaim() internal view virtual override returns (bool) {
        return claimsEnabled;
    }

    /// @dev Conservative false: proving every frozen account fully backed needs an unbounded scan;
    ///      conversion is disabled in v1 (R-11).
    function _acctAllFullyBackedAtHalt() internal view virtual override returns (bool) {
        return false;
    }

    // ================================================================ keeper / governance entry points

    function _currentTariff() internal view returns (P.Tariff memory t) {
        MarginMath.RiskParams memory p = _effectiveParams(block.timestamp);
        t = P.Tariff(p.hazard0WadPerDay, p.hazard1WadPerDay, _premiumLoadWad);
    }

    /// @dev Fixed epoch rate (DEC-02): only with the funding feature, normal pricing and valid
    ///      index and mark at the opening; truncated toward zero by A's FundingMath (R-08).
    function _openingRate() internal view returns (int256) {
        if (!fundingFeatureEnabled) return 0;
        RiskContext memory c = _pricingContext();
        if (c.pricingMode != PricingMode.NORMAL_PRICING || !c.markOk || !c.indexOk || c.fundingFrozen) return 0;
        return F.rate(c.markWad, c.indexWad);
    }

    /// @notice Governance activation after the reserve seed (DEC-06: shares issue only before this).
    function activateMarket() external nonReentrant {
        _onlyGovernance();
        _riskEpochOpenedWithGuards();
        _activate(0, _currentTariff());
    }

    /// @notice Permissionless bounded rollover (spec §5.7).
    function beginRollover() external nonReentrant {
        _beginRollover(_checkedContext());
    }

    function rollPage(uint8 maxAccounts) external nonReentrant returns (bool complete) {
        return _rollPage(maxAccounts);
    }

    function finishRollover() external nonReentrant {
        _riskEpochOpenedWithGuards();
        _finishRollover(_openingRate(), _currentTariff(), _pricingContext().fundingFreshThrough);
    }
}
