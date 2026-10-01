// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountRegistry} from "./AccountRegistry.sol";
import {CoverageMath as C} from "../math/CoverageMath.sol";

abstract contract ReserveAccounting is AccountRegistry {
    function _replaceDeficits(Account storage a) internal {
        deficitSum0 -= a.deficit0;
        deficitSum1 -= a.deficit1;
        (a.deficit0, a.deficit1) = C.deficits(a.value, a.orders);
        deficitSum0 += a.deficit0;
        deficitSum1 += a.deficit1;
    }

    function coverageSlacks() public view returns (int256, int256) {
        return C.slacks(reserve, deficitSum0, deficitSum1, fundingCushionQ, fundingBudgetQ);
    }

    function _assertCoverage() internal {
        (int256 s0, int256 s1) = coverageSlacks();
        if (s0 < 0 || s1 < 0) revert Coverage();
        _publishMarket();
    }

    function _publishMarket() internal {
        emit MarketBalance(
            allocationQ,
            reserve.lots,
            reserve.cashQ,
            protocolFeeQ,
            keeperPayableQ,
            fundingClearingQ,
            fundingCushionQ,
            fundingBudgetQ,
            oiAllLots
        );
    }

    function _publishAccount(address owner) internal {
        Account storage a = accounts[owner];
        emit AccountBalance(owner, a.value.lots, a.value.cashQ, a.fundingCheckpoint);
    }
}
