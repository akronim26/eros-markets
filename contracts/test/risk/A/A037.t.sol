// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";

contract A037Test is AccountingTestBase {
    function testBlockedRecipientDoesNotBlockOthersOrLoseClaim() public {
        _trade();
        _finish(5e17, 1);
        token.configure(alice, false);
        vm.expectRevert();
        h.claimTrader(alice);
        assertEq(h.claimableAtoms(alice), 20e6);
        h.claimTrader(bob);
        assertEq(token.balanceOf(bob), 200e6);
        vm.expectRevert();
        h.claimTrader(bob);
        token.configure(address(0), false);
        h.claimTrader(alice);
        assertEq(token.balanceOf(alice), 20e6);
    }
}
