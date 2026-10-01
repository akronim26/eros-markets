// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Side, RejectCode, RemovalReason} from "../../provisional/MathTypes.sol";
import {BookRiskAdapter} from "./BookRiskAdapter.sol";

/// @title OrderLifecycle
/// @notice Reductions and order amendments (spec §7.6, §7.7; B025): inclusive good-til-block
///         expiry, position-version reduce-only validity (no revival after long -> flat -> short
///         -> long), top-level cancel-all, market-wide invalidation, size-down with retained
///         priority and cancel/replace for anything that widens permissions.
/// @dev Expiry is also re-checked inside the fill hook, so an expired order can never execute
///      even if a book forgets to prune it. Size-down releases exactly the size delta.
abstract contract OrderLifecycle is BookRiskAdapter {
    error NotSizeDown();

    enum AmendKind {
        SIZE_DOWN, // same price/permission/expiry, smaller size: keep priority
        REPLACE, // anything else: cancel and re-admit with a new identity and priority
        NO_CHANGE
    }

    struct OrderTerms {
        Side side;
        uint16 tick;
        uint64 lots;
        uint32 expiryBlock;
        bool reduceOnly;
    }

    event OrdersInvalidated(
        uint32 indexed trader,
        uint64 marketEpoch,
        uint64 oldAccountEpoch,
        uint64 newAccountEpoch,
        RemovalReason reason
    );
    event MarketOrdersInvalidated(uint64 oldEpoch, uint64 newEpoch, uint64 riskVersion);
    event OrderAmendedDown(
        uint32 indexed trader, uint32 indexed slot, uint24 generation, uint64 oldLots, uint64 newLots
    );

    /// @notice Inclusive good-til-block: executable while block.number <= expiryBlock; 0 = none.
    function _expired(uint32 expiryBlock) internal view returns (bool) {
        return expiryBlock != 0 && block.number > expiryBlock;
    }

    function _riskTryMatchedFill(
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        OrderView memory maker,
        uint64 proposedLots
    ) internal virtual override returns (StepResult memory r) {
        if (_expired(maker.expiryBlock)) {
            _touch(maker.owner);
            return _prune(maker, false, RejectCode.STALE_ORDER);
        }
        return super._riskTryMatchedFill(snap, permit, maker, proposedLots);
    }

    /// @notice Classify an amendment. Only a strict size reduction at identical price, side,
    ///         permission and expiry keeps priority; a shorter expiry is not a supported amend rule.
    function _classifyAmend(OrderTerms memory o, OrderTerms memory n) internal pure returns (AmendKind) {
        if (
            o.side == n.side && o.tick == n.tick && o.expiryBlock == n.expiryBlock
                && o.reduceOnly == n.reduceOnly && o.lots == n.lots
        ) return AmendKind.NO_CHANGE;
        if (
            o.side == n.side && o.tick == n.tick && o.expiryBlock == n.expiryBlock
                && o.reduceOnly == n.reduceOnly && n.lots < o.lots && n.lots != 0
        ) return AmendKind.SIZE_DOWN;
        return AmendKind.REPLACE;
    }

    /// @notice Size-down: release exactly `oldLots - newLots` at the order's tick and the matching
    ///         share of its fee cap. The book keeps the node and its priority.
    function _riskAmendDown(RiskSnapshot memory snap, OrderView memory o, uint64 newLots)
        internal
        returns (uint256 newFeeCapQ)
    {
        if (newLots == 0 || newLots >= o.remainingLots) revert NotSizeDown();
        uint64 delta = o.remainingLots - newLots;
        newFeeCapQ = o.remainingFeeCapQ * newLots / o.remainingLots;
        _riskOnUnrest(snap, o.owner, o.admittedAt, o.side, o.tick, delta, o.remainingFeeCapQ - newFeeCapQ);
        emit OrderAmendedDown(o.owner, o.key.slot, o.key.generation, o.remainingLots, newLots);
    }

    /// @notice Top-level authorized cancel-all: begin/synchronize the action, touch, bump the
    ///         account order epoch once. Stale nodes remain until pruned; they can never execute.
    function _cancelAllTopLevel(uint32 trader) internal returns (EpochTag memory t) {
        RiskSnapshot memory snap = _riskBeginAction();
        uint64 oldEpoch = _acctAccount(trader).orderEpoch;
        t = _riskCancelAll(trader);
        emit OrdersInvalidated(
            trader, snap.marketOrderEpoch, oldEpoch, t.accountOrderEpoch, RemovalReason.USER_CANCEL
        );
    }

    /// @notice Market-wide invalidation (stage change / rollover / halt) without visiting accounts.
    function _invalidateMarketOrders() internal returns (uint64 newEpoch) {
        uint64 old = _acctMarketOrderEpoch();
        newEpoch = _acctBumpMarketOrderEpoch();
        emit MarketOrdersInvalidated(old, newEpoch, _riskVersion);
    }
}
