// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {PremiumAccounting} from "./PremiumAccounting.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract AccountSync is PremiumAccounting {
    function _touch(address owner, uint64 until) internal {
        Account storage a = accounts[owner];
        if (!registered[owner]) revert BadState();
        int256 payment = int256(a.value.lots) * (fundingFQ - a.fundingCheckpoint);
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
