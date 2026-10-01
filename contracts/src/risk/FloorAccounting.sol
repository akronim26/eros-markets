// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FreezeAccounting} from "./FreezeAccounting.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract FloorAccounting is FreezeAccounting {
    function _beginFloor(Context memory c) internal {
        _validateContext(c);
        if (
            work != Work.READY || halted || c.at < scheduledT - 12 hours || c.at >= epoch.end
                || c.at >= scheduledT
        ) {
            revert BadState();
        }
        _advanceFunding(c.at, c.freshThrough);
        epoch.stopped = true;
        epoch.stop = epoch.last;
        work = Work.FLOOR_SWEEP;
        fullBackingReconciled = false;
        ++generation;
        ++marketOrderEpoch;
        sweepCutoff = c.at;
        cursor = 0;
        sweepCount = participants.length;
    }

    function _floorPage(uint8 maximum) internal returns (bool complete) {
        if (work != Work.FLOOR_SWEEP || maximum == 0 || maximum > 32) revert BadState();
        if (_clock() >= scheduledT) revert BadState(); // B must materialize halt instead.
        uint256 end = Q.min(cursor + maximum, sweepCount);
        while (cursor < end) {
            address owner = participants[cursor++];
            _touch(owner, sweepCutoff);
            (int256 e0, int256 e1) = L.endpoints(accounts[owner].value);
            if (e0 < 0 || e1 < 0) _takeoverPosted(owner, sweepCutoff);
        }
        complete = cursor == sweepCount;
        if (complete) {
            if (fundingClearingQ != 0 || fundingCushionQ != 0) revert BadState();
            fullBackingReconciled = true;
            work = Work.READY;
        }
        _assertCoverage();
        emit SweepProgress(uint8(Work.FLOOR_SWEEP), generation, cursor, sweepCount);
    }
}
