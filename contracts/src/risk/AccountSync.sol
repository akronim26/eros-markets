// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {PremiumAccounting} from "./PremiumAccounting.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract AccountSync is PremiumAccounting {
    function _fundingPayment(Account storage a, int256 fundingIndex) internal view returns (int256) {
        return int256(a.value.lots) * (fundingIndex - a.fundingCheckpoint);
    }

    /// @dev View-only projection of `_touch` for previews (B-D02): the funding payment against a
    ///      projected index and the premium due at `until` with a projected funding stop.
    function _projectedTouch(Account storage a, int256 fundingIndex, uint64 fundingStop, uint64 until)
        internal
        view
        returns (int256 fundingQ, uint256 premiumQ)
    {
        fundingQ = _fundingPayment(a, fundingIndex);
        if (until <= a.lastTouchedAt || until <= _segmentStartOf(a)) return (fundingQ, 0);
        premiumQ = _premiumTotalAt(a, until, fundingStop) - a.segmentPosted;
    }

    function _touch(address owner, uint64 until) internal {
        Account storage a = accounts[owner];
        if (!registered[owner]) revert BadState();
        int256 payment = _fundingPayment(a, fundingFQ);
        a.value.cashQ = Q.cash(a.value.cashQ - payment);
        a.fundingCheckpoint = fundingFQ;
        fundingClearingQ += payment;
        fundingCushionQ -= Q.positive(payment);
        if (until < a.lastTouchedAt) revert Stale();
        uint256 premium = until == a.lastTouchedAt ? 0 : _postPremium(a, until);
        a.lastTouchedAt = until;
        if (a.reservationMarketEpoch != marketOrderEpoch) {
            delete a.orders;
            a.reservationMarketEpoch = marketOrderEpoch;
            ++a.orderEpoch;
        }
        _replaceDeficits(a);
        _publishAccount(owner);
        emit AccountSynced(owner, payment, premium, until);
    }
}
