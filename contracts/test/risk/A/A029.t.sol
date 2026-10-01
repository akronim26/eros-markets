// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A029Test is AccountingTestBase {
    function testLiquidationFeesAndWaiver() public {
        _trade();
        uint256 charged = h.liquidationPair(bob, alice, 1, 600, keeper);
        assertEq(charged, 2e18);
        assertEq(h.keeperQ(keeper), 1e18);
        decision.setRejectFees(true);
        assertEq(h.liquidationPair(bob, alice, 1, 600, keeper), 0);
        assertEq(h.keeperQ(keeper), 1e18);
        vm.prank(keeper);
        h.withdrawKeeper();
        _assertLedger();
    }
}
