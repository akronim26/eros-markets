// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskContext} from "../pricing/RiskPricing.sol";
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
///      joins are rejected until the last `_acctFloorPage`). Integration: A's page performs the
///      touch and the price-free endpoint-deficit takeover itself (A031); B orchestrates the
///      bounded pages, the reconciled flag and halt abandonment (interface-reconciliation R-07).
abstract contract FloorLifecycle is RiskLifecycle {
    error FloorNotActive();
    error BadWorkBudget();

    uint256 internal constant MAX_FLOOR_BATCH = 32;

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

    function floorSweep(uint256 maxAccounts) external returns (FloorStatus) {
        if (maxAccounts == 0 || maxAccounts > MAX_FLOOR_BATCH) revert BadWorkBudget();
        RiskContext memory c = _pricingContext();
        if (c.halted) {
            if (_floorStatus == FloorStatus.SWEEPING) _floorStatus = FloorStatus.ABANDONED_BY_HALT;
            return _emitProgress();
        }
        if (!c.fundingFrozen) revert FloorNotActive();
        if (_floorStatus == FloorStatus.RECONCILED) return _floorStatus;
        _riskBeginAction(); // also invalidates orders once at the floor
        if (_floorStatus == FloorStatus.NOT_STARTED) {
            _floorCount = _acctFloorBegin();
            _floorGeneration += 1;
            _floorStatus = FloorStatus.SWEEPING;
        }
        (JobProgress memory jp, uint64 taken) = _acctFloorPage(maxAccounts);
        _floorCursor = jp.cursor;
        _floorTakeovers += taken;
        if (jp.done) _floorStatus = FloorStatus.RECONCILED;
        return _emitProgress();
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
