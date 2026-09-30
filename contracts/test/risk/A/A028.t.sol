// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A028Test is AccountingTestBase {
    function testTakeoverNeedsActualEligibilityAndMovesBothLegs() public {
        _trade();
        vm.expectRevert();
        h.takeover(alice);
        h.setContext(uint64(block.timestamp + 30), 1e17, true);
        h.takeover(alice);
        (int128 n, int256 cash) = h.reserve();
        assertEq(n, 1000000);
        assertEq(cash, 99520e24);
        assertEq(h.account(alice).value.lots, 0);
        assertEq(h.account(alice).value.cashQ, 0);
        _assertLedger();
    }

    function testReserveUnwindCannotIncreaseOrFlipInventory() public {
        _trade();
        h.setContext(uint64(block.timestamp + 30), 1e17, true);
        h.takeover(alice);
        vm.expectRevert();
        h.reserveFill(bob, true, 1, 600);
        vm.expectRevert();
        h.reserveFill(bob, false, 1_000_001, 600);
        h.reserveFill(bob, false, 1_000_000, 600);
        (int128 n,) = h.reserve();
        assertEq(n, 0);
        assertEq(h.account(bob).value.lots, 0);
        assertEq(h.oiAllLots(), 0);
        _assertLedger();
    }
}
