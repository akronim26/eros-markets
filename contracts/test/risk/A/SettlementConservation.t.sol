// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

abstract contract SettlementConservationChecks is AccountingTestBase {
    function testFuzzPageSizesAndClaimOrder(uint8 size, bool firstAlice, uint64 price) public {
        size = uint8(uint256(size) % 32 + 1);
        uint256 p = uint256(price) % 1e18;
        _trade();
        _finish(p, size);
        assertEq(h.totalTraderAtoms() * 1e18 + h.reserveResidualQ() + h.frozenFeeQ(), h.frozenAllocationQ());
        address first = firstAlice ? alice : bob;
        address second = firstAlice ? bob : alice;
        if (h.claimableAtoms(first) > 0) h.claimTrader(first);
        if (h.claimableAtoms(second) > 0) h.claimTrader(second);
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
        assertEq((vault.marketAtoms(address(h)) * 1e18 - vault.marketDebitQ(address(h))), h.allocationQ());
    }
}
