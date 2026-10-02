// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, AccountingHarness, P} from "../../risk/A/AccountingTestBase.sol";
import {ReserveVault} from "../../../src/vaults/ReserveVault.sol";

contract CustodyExitTest is AccountingTestBase {
    function testKeeperWithdrawalKeepsFractionAndOtherMarketLiability() public {
        _trade();
        h.singleCloseFee(bob, alice, 3, 600, keeper);
        assertEq(h.keeperQ(keeper), 15e17);
        vm.prank(keeper);
        assertEq(h.withdrawKeeper(), 1);
        assertEq(h.keeperQ(keeper), 5e17);
        assertEq(vault.freeAtoms(keeper), 1);
        vm.prank(keeper);
        vault.withdraw(1);
        assertEq(token.balanceOf(keeper), 1);
        _assertLedger();
        _finish(5e17, 1);
        // A-I01: the half atom left the market for the vault's keeper pool, still owned by the keeper.
        assertEq(h.keeperPayableQ(), 0);
        assertEq(h.reclassifiedKeeperQ(), 5e17);
        assertEq(vault.keeperPoolQ(address(h)), 5e17);
        assertEq(h.keeperQ(keeper), 5e17);
        assertEq(h.allocationQ(), h.outstandingReserveAtoms() * 1e18 + h.treasuryQ());
        // Withdrawing now moves the exact half atom to the keeper's global escrow; nothing pays yet.
        vm.prank(keeper);
        assertEq(h.withdrawKeeper(), 0);
        assertEq(h.keeperQ(keeper), 0);
        assertEq(vault.keeperPoolQ(address(h)), 0);
        assertEq(vault.feeEscrowQ(keeper), 5e17);
    }

    function testAllEntitlementsExitWithoutBorrowingOtherMarket() public {
        AccountingHarness second = new AccountingHarness(vault, decision, treasury, end, false, false);
        vault.registerEngine(address(second));
        token.mint(alice, 17);
        vm.startPrank(alice);
        token.approve(address(vault), 17);
        vault.deposit(17);
        vault.allocate(address(second), 17, false);
        vm.stopPrank();
        uint256 recognized = vault.recognizedAtoms();
        token.mint(address(vault), 11);
        assertEq(vault.recognizedAtoms(), recognized);
        _trade();
        h.singleCloseFee(bob, alice, 1, 600, keeper);
        ReserveVault rv = h.reserveVault();
        vm.prank(lp);
        rv.notice();
        _finish(5e17, 1);
        vm.warp(block.timestamp + 7 days);
        h.redeemReserve(lp);
        h.withdrawTreasury();
        vault.claim(address(h), lp);
        h.claimTrader(alice);
        h.claimTrader(bob);
        if (vault.claimAtoms(address(h), treasury) > 0) vault.claim(address(h), treasury);
        assertEq(vault.marketAtoms(address(second)), 17);
        assertEq(vault.marketDebitQ(address(second)), 0);
        assertEq(h.allocationQ(), h.treasuryQ());
        assertEq(vault.keeperPoolQ(address(h)), 5e17, "keeper half atom survives every other exit");
        assertEq(vault.marketAtoms(address(h)) * 1e18 - vault.marketDebitQ(address(h)), h.allocationQ());
        assertEq(token.balanceOf(address(vault)), vault.recognizedAtoms() + 11);
    }
}
