// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A017Test is AccountingTestBase {
    function testCustodyReleaseAndTaxRejection() public {
        vm.prank(alice);
        h.release(1e6);
        assertEq(vault.freeAtoms(alice), 1e6);
        _assertLedger();
        token.mint(alice, 10);
        vm.startPrank(alice);
        token.approve(address(vault), 10);
        token.configure(address(0), true);
        vm.expectRevert();
        vault.deposit(10);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 10);
    }

    function testDepositReentryRejected() public {
        token.mint(alice, 10);
        vm.prank(alice);
        token.approve(address(vault), 10);
        token.setCallback(address(vault), abi.encodeCall(vault.deposit, (1)));
        vm.prank(alice);
        vm.expectRevert();
        vault.deposit(10);
        assertEq(token.balanceOf(alice), 10);
    }
}
