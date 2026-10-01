// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountSync} from "./AccountSync.sol";
import {PremiumMath as P} from "../math/PremiumMath.sol";
import {FundingMath as F} from "../math/FundingMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract EpochRollover is AccountSync {
    function _openEpoch(int256 rate, P.Tariff memory nextTariff, uint64 freshThrough) internal {
        if (fundingClearingQ != 0 || fundingCushionQ != 0 || halted || work != Work.READY) revert BadState();
        if (rate != 0 && !fundingFeatureEnabled) revert Rejected();
        if (
            Q.abs(rate) > 1e18 || nextTariff.hazard0WadPerDay > 1e18 || nextTariff.hazard1WadPerDay > 1e18
                || nextTariff.loadWad > 1e18
        ) revert BadUnits();
        uint64 now_ = _clock();
        if (now_ >= scheduledT) revert BadState();
        uint64 end = uint64((uint256(now_) / 1 hours + 1) * 1 hours);
        if (end > scheduledT) end = scheduledT;
        fundingBudgetQ = 0;
        (int256 s0, int256 s1) = coverageSlacks();
        uint256 slack = Q.min(Q.positive(s0), Q.positive(s1));
        bool disabled = oiAllLots == 0 || rate == 0 || now_ >= scheduledT - 12 hours || freshThrough < now_;
        if (!disabled) fundingBudgetQ = F.authorization(oiAllLots, rate, end - now_, slack);
        uint64 id = epoch.id + 1;
        epoch = Epoch(id, now_, end, now_, disabled ? now_ : end, rate, disabled);
        tariff = nextTariff;
        emit EpochOpened(id, now_, end, rate, fundingBudgetQ);
        _assertCoverage();
    }

    function _beginRollover(Context memory c) internal {
        _validateContext(c);
        if (work != Work.READY || halted || c.at < epoch.end) revert BadState();
        _advanceFunding(epoch.end, c.freshThrough);
        epoch.stopped = true;
        work = Work.ROLLOVER_SWEEP;
        ++generation;
        ++marketOrderEpoch;
        sweepCutoff = epoch.end;
        cursor = 0;
        sweepCount = participants.length;
    }

    function _rollPage(uint8 maximum) internal returns (bool complete) {
        if (work != Work.ROLLOVER_SWEEP || maximum == 0 || maximum > 32) revert BadState();
        uint256 end = Q.min(cursor + maximum, sweepCount);
        while (cursor < end) {
            address owner = participants[cursor++];
            _touch(owner, sweepCutoff);
            Account storage a = accounts[owner];
            a.premiumPaid = 0;
            a.segmentPosted = 0;
            a.segmentCash = a.value.cashQ;
            a.segmentStart = 0;
        }
        complete = cursor == sweepCount;
        if (complete && (fundingClearingQ != 0 || fundingCushionQ != 0)) revert BadState();
        _assertCoverage();
        emit SweepProgress(uint8(work), generation, cursor, sweepCount);
    }

    function _finishRollover(int256 rate, P.Tariff memory nextTariff, uint64 freshThrough) internal {
        if (work != Work.ROLLOVER_SWEEP || cursor != sweepCount) revert BadState();
        work = Work.READY;
        _openEpoch(rate, nextTariff, freshThrough);
    }
}
