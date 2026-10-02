// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingPort} from "./AccountingPort.sol";
import {FundingMath as F} from "../math/FundingMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract FundingAccounting is AccountingPort {
    struct FundingStep {
        F.Delta delta;
        bool stops;
    }

    /// @dev The next funding advance from the current state. `_advanceFunding` posts it; previews
    ///      read it without posting (B-D02), so both use the same cutoff and stop rules.
    function _fundingStep(uint64 until, uint64 freshThrough) internal view returns (FundingStep memory s) {
        uint64 cutoff = until;
        if (cutoff > epoch.end) cutoff = epoch.end;
        if (cutoff > freshThrough) cutoff = freshThrough;
        uint64 floorTime = scheduledT - 12 hours;
        if (cutoff > floorTime) cutoff = floorTime;
        if (cutoff < epoch.last) cutoff = epoch.last;
        s.delta = F.advance(cutoff - epoch.last, epoch.rate, oiAllLots, reserve.lots, fundingBudgetQ);
        s.stops = s.delta.stopped || cutoff < until || cutoff == epoch.end || cutoff == floorTime;
    }

    function _advanceFunding(uint64 until, uint64 freshThrough) internal {
        if (epoch.stopped) return;
        FundingStep memory step = _fundingStep(until, freshThrough);
        F.Delta memory d = step.delta;
        epoch.last += d.secondsAccrued;
        fundingFQ += d.indexQ;
        fundingBudgetQ -= d.flowQ;
        fundingCushionQ += d.traderPayerQ;
        reserve.cashQ = Q.cash(reserve.cashQ - d.reservePaymentQ);
        fundingClearingQ += d.reservePaymentQ;
        if (step.stops) {
            epoch.stopped = true;
            epoch.stop = epoch.last;
        }
        _assertCoverage();
        emit FundingAdvanced(fundingFQ, d.flowQ, d.reservePaymentQ, epoch.last, epoch.stopped);
    }
}
