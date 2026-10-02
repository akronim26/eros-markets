// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FloorAccounting} from "../risk/FloorAccounting.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {QMath as Q} from "../math/QMath.sol";
import {AccountingState} from "../math/MathTypes.sol";

abstract contract SnapshotLedger is FloorAccounting {
    mapping(address => L.Value) public frozen;
    L.Value public frozenReserve;
    bool public snapshotComplete;
    int256 public snapshotCashQ;
    int256 public snapshotLots;
    uint256 public frozenAllocationQ;
    uint256 public frozenFeeQ;

    function _snapshotPage(uint8 maximum) internal returns (bool complete) {
        if (work != AccountingState.HALT_SWEEP || maximum == 0 || maximum > 32) revert BadState();
        if (snapshotComplete) return true;
        uint256 end = Q.min(cursor + maximum, sweepCount);
        while (cursor < end) {
            address owner = participants[cursor++];
            _touch(owner, accrualCutoff);
            L.Value memory value = accounts[owner].value;
            frozen[owner] = value;
            snapshotCashQ += value.cashQ;
            snapshotLots += value.lots;
        }
        complete = cursor == sweepCount;
        if (complete) {
            if (fundingClearingQ != 0 || fundingCushionQ != 0 || snapshotLots + reserve.lots != 0) {
                revert BadState();
            }
            if (
                snapshotCashQ + reserve.cashQ + Q.signed(protocolFeeQ + keeperPayableQ)
                    != Q.signed(allocationQ)
            ) {
                revert BadState();
            }
            _assertCoverage();
            frozenReserve = reserve;
            frozenAllocationQ = allocationQ;
            frozenFeeQ = protocolFeeQ + keeperPayableQ;
            snapshotComplete = true;
        }
        emit SweepProgress(uint8(AccountingState.HALT_SWEEP), generation, cursor, sweepCount);
    }
}
