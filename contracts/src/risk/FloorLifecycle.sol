// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskContext} from "../pricing/RiskPricing.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {RiskLifecycle} from "./RiskLifecycle.sol";

/// @title FloorLifecycle
/// @notice Backing-floor reconciliation controller (spec §5.1, §7.6 "Final-day gates", DEC-04;
///         B029). At T - 12h the first action invalidates every resting order epoch; a bounded,
///         permissionless sweep then visits Person A's frozen account list (at most 32 per call),
///         touches each at the legal cutoff and requests a whole-account takeover for any account
///         with a negative endpoint. The market is reported reconciled only after every frozen
///         participant was visited; no clock shortcut exists. A halt abandons unfinished work.
/// @dev B decides; A performs every cash/position movement (`_acctTakeover`) and freezes the
///      registry (`_acctFloorBegin` puts the market in FLOOR_SWEEP, so live book calls and new
///      joins are rejected until `_acctFloorComplete`).
abstract contract FloorLifecycle is RiskLifecycle {
    error FloorNotActive();
    error BadWorkBudget();

    uint256 internal constant MAX_FLOOR_BATCH = 32;
    uint8 internal constant PREDICATE_FLOOR_DEFICIT = 2;

    enum FloorStatus {
        NOT_STARTED,
        SWEEPING,
        RECONCILED,
        ABANDONED_BY_HALT
    }

    FloorStatus internal _floorStatus;
    uint64 internal _floorCount;
    uint64 internal _floorCursor;
    uint64 internal _floorGeneration;
    uint64 internal _floorTakeovers;

    event FloorSweepProgress(
        uint64 generation, uint64 cursor, uint64 count, uint64 takeovers, FloorStatus status
    );
    event FloorTakeover(uint32 indexed trader, int256 e0Q, int256 e1Q, uint64 cutoff);

    function floorSweep(uint256 maxAccounts) external returns (FloorStatus) {
        if (maxAccounts == 0 || maxAccounts > MAX_FLOOR_BATCH) revert BadWorkBudget();
        RiskContext memory c = _riskContext();
        if (c.halted) {
            if (_floorStatus == FloorStatus.SWEEPING) _floorStatus = FloorStatus.ABANDONED_BY_HALT;
            return _emitProgress();
        }
        if (!c.fundingFrozen) revert FloorNotActive();
        if (_floorStatus == FloorStatus.RECONCILED) return _floorStatus;
        RiskSnapshot memory snap = _riskBeginAction(); // also invalidates orders once at the floor
        if (_floorStatus == FloorStatus.NOT_STARTED) {
            _floorCount = _acctFloorBegin();
            _floorGeneration += 1;
            _floorStatus = FloorStatus.SWEEPING;
        }
        uint64 end = _floorCursor + uint64(maxAccounts);
        if (end > _floorCount) end = _floorCount;
        for (uint64 i = _floorCursor; i < end; ++i) {
            _visit(_acctFloorTraderAt(i), snap);
        }
        _floorCursor = end;
        if (_floorCursor == _floorCount) {
            _acctFloorComplete();
            _floorStatus = FloorStatus.RECONCILED;
        }
        return _emitProgress();
    }

    function _visit(uint32 trader, RiskSnapshot memory snap) internal {
        _touch(trader);
        AccountView memory a = _acctAccount(trader);
        (int256 e0, int256 e1) = MarginMath.endpoints(a.cashQ, a.lots);
        if (e0 < 0 || e1 < 0) {
            _resCancelAll(trader);
            _acctTakeover(TakeoverAuth(trader, PREDICATE_FLOOR_DEFICIT, snap.premiumCutoff, snap.riskVersion));
            _floorTakeovers += 1;
            emit FloorTakeover(trader, e0, e1, snap.premiumCutoff);
        }
    }

    function _emitProgress() internal returns (FloorStatus) {
        emit FloorSweepProgress(_floorGeneration, _floorCursor, _floorCount, _floorTakeovers, _floorStatus);
        return _floorStatus;
    }

    function floorProgress()
        external
        view
        returns (FloorStatus status, uint64 cursor, uint64 count, uint64 generation, uint64 takeovers)
    {
        return (_floorStatus, _floorCursor, _floorCount, _floorGeneration, _floorTakeovers);
    }

    function floorReconciled() public view returns (bool) {
        return _floorStatus == FloorStatus.RECONCILED;
    }
}
