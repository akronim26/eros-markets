// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A018Test is AccountingTestBase {
    function testPairedPostingAndSecondLegRollback() public {
        decision.set(bob, false);
        vm.expectRevert();
        h.trade(alice, bob, 1000000, 600, 0, 0);
        assertEq(h.account(alice).value.lots, 0);
        decision.set(bob, true);
        _trade();
        assertEq(h.account(alice).value.cashQ, -480e24);
        assertEq(h.account(bob).value.cashQ, 700e24);
        _assertLedger();
    }
}
