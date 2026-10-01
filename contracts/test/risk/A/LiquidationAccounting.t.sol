// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "./AccountingTestBase.sol";

abstract contract LiquidationAccountingChecks is AccountingTestBase {
    function testPositiveEquityAndStaleMarkAreNotTakeoverPermission() public {
        _trade();
        h.setContext(uint64(block.timestamp - 1), 1e17, false);
        vm.expectRevert();
        h.takeover(alice);
        assertEq(h.keeperPayableQ(), 0);
        _assertLedger();
    }

    function testHaltInterruptsFloorAndPreservesRemainingAccounts() public {
        _trade();
        vm.warp(end - 12 hours);
        h.beginRoll();
        h.rollPage(32);
        h.finishRoll(0, P.Tariff(0, 0, 0));
        h.beginFloor();
        h.floorPage(1);
        h.freeze(uint64(block.timestamp));
        vm.expectRevert();
        h.floorPage(1);
        h.snapshotPage(32);
        assertTrue(h.snapshotComplete());
        assertEq(h.account(bob).value.lots, -1000000);
    }
}
