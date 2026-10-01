// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Stage} from "../../provisional/MathTypes.sol";
import {LifecycleMath} from "../math/LifecycleMath.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {TradePreview} from "./TradePreview.sol";

/// @title RiskLifecycle
/// @notice Derived stage and grace state (spec §4.3, §5.1; B028). Stage is derived from time on
///         every action (no keeper transition needed for a restriction to apply); the first action
///         at or after the backing floor also invalidates every resting order epoch. Each account
///         carries a nonrenewable grace anchored to the risk epoch in which it was first seen
///         below IM; touching it again never restarts the clock; below MM has no grace.
/// @dev Grace length is `GRACE_SECS` (assumption M-5), capped at T - 12h by LifecycleMath.
abstract contract RiskLifecycle is TradePreview {
    uint64 internal constant GRACE_SECS = 3600;

    mapping(uint32 trader => LifecycleMath.GraceState) internal _grace;
    bool internal _floorOrdersInvalidated;

    event GraceStarted(uint32 indexed trader, uint64 anchor, uint64 riskVersion);
    event GraceCleared(uint32 indexed trader);
    event FloorOrdersInvalidated(uint64 at, uint64 newMarketEpoch);

    /// @notice Derive the stage first; invalidate resting orders once at the floor, then start the
    ///         ordinary action (so the snapshot carries the new market order epoch).
    function _riskBeginAction() internal virtual override returns (RiskSnapshot memory) {
        _syncStage();
        return super._riskBeginAction();
    }

    function _syncStage() internal {
        RiskContext memory c = _riskContext();
        if (c.fundingFrozen && !_floorOrdersInvalidated) {
            _floorOrdersInvalidated = true;
            uint64 e = _invalidateMarketOrders();
            emit FloorOrdersInvalidated(c.economicTime, e);
        }
    }

    function _afterTouch(uint32 trader) internal virtual override {
        _updateGrace(trader, _actionCtx);
    }

    /// @notice Health of a (touched) account at the frozen context; `usable` is false when there is
    ///         no normal mark (grace and mark-based eligibility then cannot be judged).
    function _health(uint32 trader, RiskContext memory c)
        internal
        view
        returns (bool usable, MarginMath.Health memory h)
    {
        if (!c.markOk) return (false, h);
        AccountView memory a = _acctAccount(trader);
        MarginMath.Margin memory m = MarginMath.sideMargin(
            _absLots(a.lots),
            a.lots > 0,
            c.markWad,
            c.secsToT,
            c.economicTime,
            _effectiveParams(c.economicTime)
        );
        return (true, MarginMath.health(a.cashQ, a.lots, c.markWad, m));
    }

    function _updateGrace(uint32 trader, RiskContext memory c) internal {
        (bool usable, MarginMath.Health memory h) = _health(trader, c);
        if (!usable) return;
        bool belowIm = h.status == MarginMath.Status.BELOW_IM || h.status == MarginMath.Status.BELOW_MM
            || h.status == MarginMath.Status.NONPOSITIVE;
        LifecycleMath.GraceState memory g = _grace[trader];
        LifecycleMath.GraceState memory n = LifecycleMath.graceOnTouch(g, belowIm, _active.effectiveAt);
        if (n.active && !g.active) emit GraceStarted(trader, n.anchor, c.riskVersion);
        if (!n.active && g.active) emit GraceCleared(trader);
        _grace[trader] = n;
    }

    function _graceExpired(uint32 trader, RiskContext memory c, bool belowMm) internal view returns (bool) {
        return LifecycleMath.graceExpired(_grace[trader], GRACE_SECS, c.economicTime, c.scheduledT, belowMm);
    }

    function graceState(uint32 trader) external view returns (LifecycleMath.GraceState memory) {
        return _grace[trader];
    }

    /// @notice Current derived stage (no keeper needed).
    function currentStage() external view returns (Stage) {
        return _riskContext().stage;
    }
}
