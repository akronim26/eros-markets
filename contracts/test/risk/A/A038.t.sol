// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";
import {ReserveVault} from "../../../src/vaults/ReserveVault.sol";

contract A038Test is AccountingTestBase {
    function testLpExitPreservesUserAndFractionalKeeperLiabilities() public {
        _trade();
        assertEq(h.singleCloseFee(bob, alice, 1, 600, keeper), 1e18);
        assertEq(h.keeperQ(keeper), 5e17);
        ReserveVault rv = h.reserveVault();
        vm.prank(lp);
        rv.notice();
        _finish(5e17, 1);
        vm.warp(block.timestamp + 7 days);
        h.redeemReserve(lp);
        vault.claim(address(h), lp);
        assertEq(h.keeperQ(keeper), 5e17);
        assertGt(h.claimableAtoms(alice), 0);
        assertGt(h.claimableAtoms(bob), 0);
        h.claimTrader(alice);
        h.claimTrader(bob);
        h.withdrawTreasury();
        assertEq(h.allocationQ(), h.treasuryQ() + h.keeperPayableQ());
        assertEq(vault.marketAtoms(address(h)) * 1e18, h.allocationQ());
    }
}
