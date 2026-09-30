// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IAccountingPort} from "../../../provisional/IAccountingPort.sol";
import {AccountingState, FinalOutcome} from "../../../provisional/MathTypes.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";

/// @notice Test-side coverage script: the test contract answers A's coverage question for fixed
///         fixtures (hand-derived / spec §7.3 formula). Keeps that logic out of the double.
interface ICoverageScript {
    function coverage(uint32 trader, int256 cashQ, int256 lots, OA.OrderSums calldata sums)
        external
        view
        returns (OA.CoverageInput memory);
}

/// @title MockAccountingPort (B020)
/// @notice Scripted double of Person A's accounting port (provisional/IAccountingPort.sol). It
///         records every call and reverts on unexpected sequencing (touch before begin, posting an
///         untouched account, posting during a sweep, jobs out of order). It holds a scripted
///         account table and applies only the exact paired lot/cash deltas it is told to post;
///         it has no funding, premium, fee-split or coverage logic (coverage is scripted).
/// @dev Not a second economic engine: every economic number it returns was set by the test or is
///      the literal paired delta `dx = +-lots, dc = -dx * tick * Q - fee` from the call itself.
abstract contract MockAccountingPort is IAccountingPort {
    error MockSequence(string what);
    error MockUnscripted(string what);

    uint256 internal constant QM = 1e18;

    enum CallKind {
        BEGIN,
        TOUCH,
        REPLACE,
        POST_FILL,
        BUMP_ACCOUNT_EPOCH,
        BUMP_MARKET_EPOCH,
        TAKEOVER,
        POST_LIQ_FILL,
        FLOOR_BEGIN,
        FLOOR_COMPLETE,
        FREEZE,
        SNAPSHOT_CHUNK,
        PAYOUT_CHUNK,
        FINISH
    }

    struct Call {
        CallKind kind;
        uint32 a;
        uint32 b;
        uint256 x;
        uint64 action;
    }

    Call[] public mockCalls;
    mapping(uint32 => AccountView) internal _mAccts;
    uint32[] internal _mTraders;
    mapping(uint32 => uint64) internal _mTouchedIn;
    mapping(uint32 => OA.OrderSums) public mockContribution;
    uint64 internal _mAction;
    bool internal _mActionOpen;
    AccountingState internal _mState;
    uint64 internal _mMarketEpoch = 1;
    uint64 internal _mCutoff;
    ICoverageScript internal _mCoverage;
    int256 public mockReserveCashQ;
    int256 public mockReserveLots;
    uint256 public mockKeeperFeesQ;
    bool internal _mFrozen;
    FreezeResult internal _mFreeze;
    FinishResult internal _mFinish;
    uint64 internal _mSnapCursor;
    uint64 internal _mPayCursor;
    bool internal _mFloorOpen;

    // ---------------------------------------------------------------- scripting (tests only)

    function mockSetAccount(uint32 trader, int256 cashQ, int256 lots) public {
        if (!_mAccts[trader].registered) _mTraders.push(trader);
        AccountView storage a = _mAccts[trader];
        a.cashQ = cashQ;
        a.lots = lots;
        a.registered = true;
        if (a.orderEpoch == 0) a.orderEpoch = 1;
    }

    function mockSetCoverageScript(ICoverageScript s) public {
        _mCoverage = s;
    }

    function mockSetState(AccountingState s) public {
        _mState = s;
    }

    function mockSetCutoff(uint64 c) public {
        _mCutoff = c;
    }

    function mockScriptFreeze(FreezeResult memory f) public {
        _mFreeze = f;
    }

    function mockScriptFinish(FinishResult memory f) public {
        _mFinish = f;
    }

    function mockCallCount() external view returns (uint256) {
        return mockCalls.length;
    }

    function mockAccount(uint32 trader) external view returns (AccountView memory) {
        return _mAccts[trader];
    }

    function _log(CallKind k, uint32 a, uint32 b, uint256 x) internal {
        mockCalls.push(Call(k, a, b, x, _mAction));
    }

    function _requireTouched(uint32 t) internal view {
        if (!_mActionOpen || _mTouchedIn[t] != _mAction) {
            revert MockSequence("account not touched in this action");
        }
    }

    // ---------------------------------------------------------------- trading

    function _acctBeginAction() internal virtual override returns (AccrualView memory v) {
        _mAction += 1;
        _mActionOpen = true;
        _log(CallKind.BEGIN, 0, 0, _mAction);
        v.cutoff = _mCutoff == 0 ? uint64(block.timestamp) : _mCutoff;
        v.accountingEpochId = 1;
        v.state = _mState;
        v.marketOrderEpoch = _mMarketEpoch;
    }

    function _acctTouch(uint32 trader) internal virtual override {
        if (!_mActionOpen) revert MockSequence("touch before begin");
        if (!_mAccts[trader].registered) revert MockUnscripted("unknown trader");
        _mTouchedIn[trader] = _mAction;
        _log(CallKind.TOUCH, trader, 0, 0);
    }

    function _acctAccount(uint32 trader) internal view virtual override returns (AccountView memory) {
        return _mAccts[trader];
    }

    function _acctCoverage(uint32 trader, OA.OrderSums memory sums, int256 dCashQ, int256 dLots)
        internal
        view
        virtual
        override
        returns (OA.CoverageInput memory)
    {
        if (address(_mCoverage) == address(0)) revert MockUnscripted("coverage");
        AccountView memory a = _mAccts[trader];
        return _mCoverage.coverage(trader, a.cashQ + dCashQ, a.lots + dLots, sums);
    }

    function _acctReplaceContribution(uint32 trader, OA.OrderSums memory sums) internal virtual override {
        _requireTouched(trader);
        mockContribution[trader] = sums;
        _log(CallKind.REPLACE, trader, 0, sums.bidLots + sums.askLots);
    }

    uint256 internal _mPosts;
    uint256 internal _mFailPostAt; // 0 = never; k = the k-th posting reverts (injected A invariant)

    function mockFailPostAt(uint256 k) public {
        _mFailPostAt = k;
    }

    function _acctPostFill(FillDelta memory d) internal virtual override {
        _mPosts += 1;
        if (_mPosts == _mFailPostAt) revert MockSequence("injected accounting invariant failure");
        if (_mState != AccountingState.READY) revert MockSequence("post during sweep");
        _requireTouched(d.maker);
        _requireTouched(d.taker);
        if (d.lots == 0 || d.tick < 1 || d.tick > 999 || d.maker == d.taker) revert MockSequence("bad fill");
        int256 dx = d.takerBuys ? int256(uint256(d.lots)) : -int256(uint256(d.lots));
        int256 notional = int256(uint256(d.lots) * d.tick * QM);
        _applyDelta(d.taker, dx, d.takerBuys ? -notional : notional, d.takerFeeQ);
        _applyDelta(d.maker, -dx, d.takerBuys ? notional : -notional, d.makerFeeQ);
        _log(CallKind.POST_FILL, d.maker, d.taker, d.lots);
    }

    function _applyDelta(uint32 t, int256 dx, int256 dc, uint256 fee) internal {
        AccountView storage a = _mAccts[t];
        int256 before = a.lots;
        a.lots += dx;
        a.cashQ += dc - int256(fee);
        if ((before > 0) != (a.lots > 0) || (before < 0) != (a.lots < 0)) a.positionVersion += 1;
    }

    function _acctAccountingState() internal view virtual override returns (AccountingState) {
        return _mState;
    }

    function _acctBumpAccountOrderEpoch(uint32 trader) internal virtual override returns (uint64) {
        _requireTouched(trader);
        _mAccts[trader].orderEpoch += 1;
        _log(CallKind.BUMP_ACCOUNT_EPOCH, trader, 0, _mAccts[trader].orderEpoch);
        return _mAccts[trader].orderEpoch;
    }

    function _acctBumpMarketOrderEpoch() internal virtual override returns (uint64) {
        _mMarketEpoch += 1;
        _log(CallKind.BUMP_MARKET_EPOCH, 0, 0, _mMarketEpoch);
        return _mMarketEpoch;
    }

    function _acctMarketOrderEpoch() internal view virtual override returns (uint64) {
        return _mMarketEpoch;
    }

    mapping(uint32 => int256) internal _mProjFunding;
    mapping(uint32 => uint256) internal _mProjPremium;

    function mockSetProjection(uint32 trader, int256 fundingQ, uint256 premiumQ) public {
        (_mProjFunding[trader], _mProjPremium[trader]) = (fundingQ, premiumQ);
    }

    function _acctProjectedAccrual(uint32 trader, uint64)
        internal
        view
        virtual
        override
        returns (int256, uint256)
    {
        return (_mProjFunding[trader], _mProjPremium[trader]);
    }

    // ---------------------------------------------------------------- liquidation

    function _acctTakeover(TakeoverAuth memory auth) internal virtual override {
        _requireTouched(auth.trader);
        if (auth.predicate == 0) revert MockSequence("takeover without predicate");
        AccountView storage a = _mAccts[auth.trader];
        mockReserveCashQ += a.cashQ;
        mockReserveLots += a.lots;
        (a.cashQ, a.lots) = (0, 0);
        a.orderEpoch += 1;
        _log(CallKind.TAKEOVER, auth.trader, 0, auth.predicate);
    }

    function _acctPostLiquidationFill(FillDelta memory d, uint256 liquidationFeeQ, address)
        internal
        virtual
        override
    {
        _acctPostFill(d);
        mockKeeperFeesQ += liquidationFeeQ;
        _log(CallKind.POST_LIQ_FILL, d.maker, d.taker, liquidationFeeQ);
    }

    function _acctFloorBegin() internal virtual override returns (uint64) {
        _mFloorOpen = true;
        _log(CallKind.FLOOR_BEGIN, 0, 0, _mTraders.length);
        return uint64(_mTraders.length);
    }

    function _acctFloorTraderAt(uint64 index) internal view virtual override returns (uint32) {
        if (!_mFloorOpen) revert MockSequence("floor not begun");
        return _mTraders[index];
    }

    function _acctFloorComplete() internal virtual override {
        if (!_mFloorOpen) revert MockSequence("floor not begun");
        _mFloorOpen = false;
        _log(CallKind.FLOOR_COMPLETE, 0, 0, 0);
    }

    function _acctAccountCount() internal view virtual override returns (uint64) {
        return uint64(_mTraders.length);
    }

    // ---------------------------------------------------------------- settlement jobs

    function _acctFreeze(uint64, uint64 accrualCutoff)
        internal
        virtual
        override
        returns (FreezeResult memory f)
    {
        if (_mFrozen) revert MockSequence("frozen twice");
        _mFrozen = true;
        f = _mFreeze;
        f.accrualCutoff = accrualCutoff;
        if (f.frozenAccountCount == 0) f.frozenAccountCount = uint64(_mTraders.length);
        _mFreeze = f;
        _log(CallKind.FREEZE, 0, 0, accrualCutoff);
    }

    function _acctPrepareSnapshotChunk(uint256 maxAccounts)
        internal
        virtual
        override
        returns (JobProgress memory p)
    {
        if (!_mFrozen) revert MockSequence("snapshot before freeze");
        uint64 n = _mFreeze.frozenAccountCount;
        uint64 step = uint64(maxAccounts);
        _mSnapCursor = _mSnapCursor + step >= n ? n : _mSnapCursor + step;
        p = JobProgress(_mSnapCursor, n, _mSnapCursor == n);
        _log(CallKind.SNAPSHOT_CHUNK, 0, 0, _mSnapCursor);
    }

    function _acctPreparePayoutChunk(uint256 maxAccounts, FinalOutcome o, uint256)
        internal
        virtual
        override
        returns (JobProgress memory p)
    {
        uint64 n = _mFreeze.frozenAccountCount;
        if (_mSnapCursor != n) revert MockSequence("payout before snapshot complete");
        if (o == FinalOutcome.UNSET) revert MockSequence("payout without outcome");
        uint64 step = uint64(maxAccounts);
        _mPayCursor = _mPayCursor + step >= n ? n : _mPayCursor + step;
        p = JobProgress(_mPayCursor, n, _mPayCursor == n);
        _log(CallKind.PAYOUT_CHUNK, 0, 0, _mPayCursor);
    }

    function _acctFinishPreparation() internal virtual override returns (FinishResult memory) {
        if (_mPayCursor != _mFreeze.frozenAccountCount || !_mFrozen) {
            revert MockSequence("finish before payouts");
        }
        _log(CallKind.FINISH, 0, 0, 0);
        return _mFinish;
    }

    function _mockEndAction() internal {
        _mActionOpen = false;
    }
}
