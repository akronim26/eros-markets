// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {LiquidationFees} from "./LiquidationFees.sol";
import {AccountingState} from "../math/MathTypes.sol";

abstract contract FreezeAccounting is LiquidationFees {
    /// @notice Called only after B authenticates the halt; no balances can be supplied.
    function _freeze(uint64 haltAt, uint64 freshThrough) internal returns (bool) {
        if (halted) return false;
        if (haltAt > _clock() || haltAt > scheduledT || (active && haltAt < epoch.start)) revert BadState();
        uint64 cutoff = active && epoch.end < haltAt ? epoch.end : haltAt;
        if (!active) {
            epoch = Epoch(0, haltAt, haltAt, haltAt, haltAt, 0, true);
        }
        if (cutoff < epoch.last) revert Stale();
        _advanceFunding(cutoff, freshThrough);
        halted = true;
        economicHaltAt = haltAt;
        haltRecordedAt = _clock();
        accrualCutoff = cutoff;
        oiHaltLots = oiAllLots;
        epoch.stopped = true;
        if (epoch.stop > epoch.last) epoch.stop = epoch.last;
        work = AccountingState.HALT_SWEEP;
        ++generation;
        _bumpMarketOrderEpoch();
        sweepCutoff = cutoff;
        cursor = 0;
        sweepCount = participants.length;
        emit EconomicHalt(haltAt, haltRecordedAt, cutoff, oiHaltLots);
        return true;
    }
}
