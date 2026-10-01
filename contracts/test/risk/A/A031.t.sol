// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "./AccountingTestBase.sol";

contract A031Test is AccountingTestBase {
    function testBoundedFloorFreezesEnrollmentAndTransfersDeficits() public {
        _trade();
        vm.warp(end - 12 hours);
        h.beginRoll();
        h.rollPage(32);
        h.finishRoll(0, P.Tariff(0, 0, 0));
        h.beginFloor();
        assertFalse(h.fullBackingReconciled());
        vm.expectRevert();
        h.registerOnly(address(444));
        h.floorPage(1);
        assertFalse(h.fullBackingReconciled());
        h.floorPage(1);
        assertTrue(h.fullBackingReconciled());
        assertEq(h.account(alice).value.lots, 0);
        assertEq(h.account(bob).value.lots, 0);
        _assertLedger();
    }
}
