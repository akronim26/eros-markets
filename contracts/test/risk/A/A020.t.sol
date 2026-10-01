// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase} from "./AccountingTestBase.sol";
import {ReserveVault} from "../../../src/vaults/ReserveVault.sol";

contract A020Test is AccountingTestBase {
    function testSeedTopUpDoesNotDuplicateHolderAndNoticeMustCoverNewShares() public {
        ReserveVault rv = new ReserveVault(address(this));
        rv.mintSeed(alice, 10);
        vm.prank(alice);
        rv.notice();
        rv.mintSeed(alice, 20);
        assertEq(rv.holderCount(), 1);
        assertEq(rv.totalShares(), 30);
        rv.activate();
        rv.prepare(alice, 60);
        rv.finish();
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert();
        rv.consume(alice);
        vm.prank(alice);
        rv.notice();
        vm.warp(block.timestamp + 7 days);
        assertEq(rv.consume(alice), 60);
        vm.expectRevert();
        rv.consume(alice);
    }

    function testReserveHolderBoundAllowsExistingHolderTopUp() public {
        ReserveVault rv = new ReserveVault(address(this));
        for (uint160 i = 1; i <= 256; i++) {
            rv.mintSeed(address(i), 1);
        }
        rv.mintSeed(address(1), 1);
        assertEq(rv.holderCount(), 256);
        assertEq(rv.totalShares(), 257);
        vm.expectRevert();
        rv.mintSeed(address(257), 1);
    }

    function testReserveLiveDonationHasNoSharesAndNoLiveRedemption() public {
        uint256 beforeShares = h.reserveVault().totalShares();
        _fund(lp, 1e6, true);
        assertEq(h.reserveVault().totalShares(), beforeShares);
        assertEq(h.reserveCapBaseQ(), 100000e24);
        ReserveVault rv = h.reserveVault();
        vm.prank(lp);
        rv.notice();
        vm.expectRevert();
        h.redeemReserve(lp);
        _assertLedger();
    }
}
