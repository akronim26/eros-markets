// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AdmissionMode} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {LiquidationMath as LM} from "../math/LiquidationMath.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {LiquidationEligibility} from "./LiquidationEligibility.sol";

/// @title LiquidationBookAdapter
/// @notice Bounded book close and continuation (spec §5.2 step 2; B031). Sizes the close with the
///         LiquidationMath estimate, derives the fee-aware worst tick, and submits a reduce-only
///         IOC with FORCED_REDUCTION through the ordinary book hooks. Every fill is rechecked
///         against the allowed-reduction predicate with its one-atom-per-lot fee (waived as
///         needed), and actual post-fill health is recomputed from Person A's state.
/// @dev Per-block market liquidation-lot pacing uses the listing's measured cap; a missing cap
///      disables mark-based forced-book liquidation. Work or liquidity exhaustion with positive
///      equity returns NEEDS_MORE_WORK; it never authorizes a takeover. The IOC never rests.
abstract contract LiquidationBookAdapter is LiquidationEligibility {
    struct CloseOutcome {
        LM.Result result;
        uint64 requestedLots;
        uint64 closedLots;
        uint16 worstTick;
        uint256 examined;
    }

    bool internal _liqActive;
    address internal _liqKeeper;
    uint32 internal _liqTarget;
    uint64 internal _liqBlock;
    uint64 internal _liqUsedInBlock;

    event BookCloseAttempt(
        uint32 indexed trader, uint64 requestedLots, uint64 closedLots, uint16 worstTick, LM.Result result
    );

    /// @dev Book entry supplied by the composed engine: run `req` as an IOC through the book's
    ///      ordinary traversal with FORCED_REDUCTION (CP-BOOK interface item I-10). Returns filled
    ///      lots and examined makers.
    function _liqSubmitIoc(OrderRequest memory req) internal virtual returns (uint64 filled, uint256 examined);

    function _forcedReductionAuthorized() internal view virtual override returns (bool) {
        return _liqActive;
    }

    function _forcedFillFee(TakerPermit memory permit, OrderView memory maker, uint64 lots)
        internal
        view
        virtual
        override
        returns (bool ok, uint256 feeQ)
    {
        if (!_liqActive || permit.trader != _liqTarget) return (false, 0);
        AccountView memory a = _acctAccount(permit.trader);
        Leg memory g = _reduced(a.cashQ, a.lots, lots, maker.tick, _actionCtx);
        return (LM.allowedReduction(g.before, g.afterFee), g.fee);
    }

    function _postFillDelta(FillDelta memory d, bool forced) internal virtual override returns (uint256) {
        if (forced) return _acctPostLiquidationFill(d, d.takerFeeQ, _liqKeeper);
        return super._postFillDelta(d, forced);
    }

    function _blockRemaining() internal view returns (uint64) {
        uint64 cap = _listing.maxLiqLotsPerBlock;
        if (_liqBlock != uint64(block.number)) return cap;
        return cap > _liqUsedInBlock ? cap - _liqUsedInBlock : 0;
    }

    /// @notice One bounded close attempt for an eligible (REDUCE) account whose commitments were
    ///         already cancelled.
    function _bookClose(
        uint32 trader,
        uint64 maxLots,
        uint16 maxExaminations,
        RiskContext memory c,
        address keeper
    ) internal returns (CloseOutcome memory o) {
        (uint256 allowed, bool disabled) = LM.pacing(
            maxLots, maxExaminations, _listing.maxLiqLotsPerBlock != 0, _blockRemaining()
        );
        if (disabled) return _closeResult(trader, o, LM.Result.DISABLED);
        AccountView memory a = _acctAccount(trader);
        if (a.lots == 0) return _closeResult(trader, o, LM.Result.DONE);
        if (allowed == 0) return _closeResult(trader, o, LM.Result.NEEDS_MORE_WORK);
        uint64 n;
        (n, o.worstTick) = _sizeAndWorstTick(a, uint64(allowed), c);
        if (o.worstTick == 0) return _closeResult(trader, o, LM.Result.NEEDS_MORE_WORK);
        o.requestedLots = n;
        OrderRequest memory req = OrderRequest(
            trader,
            a.lots > 0 ? MathTypes.Side.SELL : MathTypes.Side.BUY,
            OrderKind.IOC,
            o.worstTick,
            n,
            0,
            true,
            maxExaminations
        );
        (_liqActive, _liqKeeper, _liqTarget) = (true, keeper, trader);
        (o.closedLots, o.examined) = _liqSubmitIoc(req);
        (_liqActive, _liqKeeper, _liqTarget) = (false, address(0), 0);
        if (_liqBlock != uint64(block.number)) (_liqBlock, _liqUsedInBlock) = (uint64(block.number), 0);
        _liqUsedInBlock += o.closedLots;
        return _closeResult(trader, o, _continuation(trader, c));
    }

    /// @dev Estimated close size (rounded up, clamped to budget and |x|) and the fee-aware worst
    ///      tick for that size; worstTick 0 means no permissible price exists.
    function _sizeAndWorstTick(AccountView memory a, uint64 allowed, RiskContext memory c)
        internal
        view
        returns (uint64 n, uint16 worstTick)
    {
        n = _closeSize(a, allowed, c);
        worstTick = _worstTick(a, n, c);
    }

    function _closeSize(AccountView memory a, uint64 allowed, RiskContext memory c)
        internal
        view
        returns (uint64)
    {
        MarginMath.RiskParams memory p = _effectiveParams(c.economicTime);
        MarginMath.Margin memory m =
            MarginMath.sideMargin(_absLots(a.lots), a.lots > 0, c.markWad, c.secsToT, c.economicTime, p);
        int256 em = MarginMath.markEquityQ(a.cashQ, a.lots, c.markWad);
        (uint256 est,) = LM.sizeEstimateLots(m.imQ, em, a.lots, p.sWad, p.lambdaWadPerClaim);
        uint256 size = est == 0 ? 1 : est;
        if (size > allowed) size = allowed;
        if (size > _absLots(a.lots)) size = _absLots(a.lots);
        return uint64(size);
    }

    function _worstTick(AccountView memory a, uint64 n, RiskContext memory c) internal view returns (uint16) {
        LM.Snap memory b = _snapAt(a.cashQ, a.lots, c);
        int256 remaining = a.lots > 0 ? a.lots - int256(uint256(n)) : a.lots + int256(uint256(n));
        int256 th = LM.thresholdQ(_snapAt(0, remaining, c).mmQ, b.emQ, b.mmQ);
        (uint16 t, bool feasible) =
            LM.bankruptcyTick(a.lots, n, a.cashQ, c.markWad, uint256(n) * LM.FEE_Q_PER_LOT, th);
        return feasible ? t : 0;
    }

    /// @dev Recompute actual health from A's post-fill state.
    function _continuation(uint32 trader, RiskContext memory c) internal view returns (LM.Result) {
        AccountView memory a = _acctAccount(trader);
        if (a.lots == 0) return LM.Result.DONE;
        (, MarginMath.Health memory h) = _health(trader, c);
        return LM.continuation(h.status == MarginMath.Status.HEALTHY, a.lots, h.markEquityQ);
    }

    function _closeResult(uint32 trader, CloseOutcome memory o, LM.Result r)
        internal
        returns (CloseOutcome memory)
    {
        o.result = r;
        emit BookCloseAttempt(trader, o.requestedLots, o.closedLots, o.worstTick, r);
        return o;
    }

    function liquidationBlockBudget() external view returns (uint64 cap, uint64 remaining) {
        return (_listing.maxLiqLotsPerBlock, _blockRemaining());
    }
}
