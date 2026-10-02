// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundingAccounting} from "./FundingAccounting.sol";
import {PremiumMath as P} from "../math/PremiumMath.sol";
import {CoverageMath as C} from "../math/CoverageMath.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract PremiumAccounting is FundingAccounting {
    function _segmentStartOf(Account storage a) internal view returns (uint64) {
        return a.segmentStart < epoch.start ? epoch.start : a.segmentStart;
    }

    function _premiumTotal(Account storage a, uint64 until) internal view returns (uint256) {
        return _premiumTotalAt(a, until, epoch.stop);
    }

    /// @dev Cumulative segment premium with an explicit funding stop; previews pass the projected stop.
    function _premiumTotalAt(Account storage a, uint64 until, uint64 fundingStop)
        internal
        view
        returns (uint256)
    {
        uint64 start = _segmentStartOf(a);
        if (until <= start) return 0;
        P.Segment memory s =
            P.Segment(a.segmentCash, a.value.lots, epoch.rate, start, fundingStop, a.surchargeUntil);
        return P.cumulative(s, tariff, until);
    }

    function _postPremium(Account storage a, uint64 until) internal returns (uint256 charge) {
        uint256 total = _premiumTotal(a, until);
        charge = total - a.segmentPosted;
        a.segmentPosted = total;
        a.premiumPaid += charge;
        a.value.cashQ = Q.cash(a.value.cashQ - Q.signed(charge));
        reserve.cashQ = Q.cash(reserve.cashQ + Q.signed(charge));
    }

    function _principalDeficits(Account storage a) internal view returns (uint256, uint256) {
        C.Orders memory none;
        return C.deficits(L.Value(a.value.lots, a.value.cashQ + Q.signed(a.premiumPaid)), none);
    }

    function _restartSegment(Account storage a, uint64 at, uint256 before0, uint256 before1) internal {
        (uint256 after0, uint256 after1) = _principalDeficits(a);
        if (after0 > before0 || after1 > before1) a.surchargeUntil = at + 6 hours;
        a.segmentCash = Q.cash(a.value.cashQ + Q.signed(a.premiumPaid));
        a.segmentStart = at;
        a.segmentPosted = 0;
    }
}
