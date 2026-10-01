// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingPort} from "./AccountingPort.sol";
import {FundingMath as F} from "../math/FundingMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract FundingAccounting is AccountingPort {
    function _advanceFunding(uint64 until, uint64 freshThrough) internal {
        if (epoch.stopped) return;
        uint64 cutoff = until;
        if (cutoff > epoch.end) cutoff = epoch.end;
        if (cutoff > freshThrough) cutoff = freshThrough;
        uint64 floorTime = scheduledT - 12 hours;
        if (cutoff > floorTime) cutoff = floorTime;
        if (cutoff < epoch.last) cutoff = epoch.last;
        F.Delta memory d = F.advance(cutoff - epoch.last, epoch.rate, oiAllLots, reserve.lots, fundingBudgetQ);
        epoch.last += d.secondsAccrued;
        fundingFQ += d.indexQ;
        fundingBudgetQ -= d.flowQ;
        fundingCushionQ += d.traderPayerQ;
        reserve.cashQ = Q.cash(reserve.cashQ - d.reservePaymentQ);
        fundingClearingQ += d.reservePaymentQ;
        if (d.stopped || cutoff < until || cutoff == epoch.end || cutoff == floorTime) {
            epoch.stopped = true;
            epoch.stop = epoch.last;
        }
        _assertCoverage();
        emit FundingAdvanced(fundingFQ, d.flowQ, d.reservePaymentQ, epoch.last, epoch.stopped);
    }
}
