// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A019Test is AccountingTestBase {
    function testBothCoverageSidesAndExcessRollback() public {
        _trade();
        assertEq(h.deficitSum0(), 480e24);
        assertEq(h.deficitSum1(), 300e24);
        vm.expectRevert();
        h.trade(alice, bob, 1_000_000_000, 600, 0, 0);
        assertEq(h.account(alice).value.lots, 1000000);
        _assertLedger();
    }
}
