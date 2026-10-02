// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AccountingHarness} from "../../harness/A/AccountingHarness.sol";
import {MockRiskDecision} from "../../mocks/A/MockRiskDecision.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";

contract FindingAF03ProtocolFeeEscrowTest is Test {
    function testProtocolFeeStaysSeparatelyClassified() public {
        vm.warp(86_400);
        MockUSDC token = new MockUSDC();
        CollateralVault vault = new CollateralVault(address(token), address(this));
        MockRiskDecision decision = new MockRiskDecision();
        AccountingHarness h = new AccountingHarness(
            vault, decision, address(0x777), uint64(block.timestamp + 10 days), false, false
        );
        vault.registerEngine(address(h));
        address alice = address(0xA11CE);
        address bob = address(0xB0B);
        _fund(token, vault, h, address(0xCAFE), 100_000e6, true);
        _fund(token, vault, h, alice, 120e6, false);
        _fund(token, vault, h, bob, 100e6, false);
        decision.set(alice, true);
        decision.set(bob, true);
        h.activate(0, P.Tariff(0, 0, 0));
        h.trade(alice, bob, 1_000_000, 600, 1.5e18, 0.5e18); // 2 Q-atoms of protocol fee
        assertEq(h.protocolFeeQ(), 2e18);
        h.freeze(uint64(block.timestamp));
        h.finalPrice(0, bytes32(uint256(1)));
        while (!h.snapshotComplete()) h.snapshotPage(32);
        while (!h.payoutScanComplete()) h.scanPayout(32);
        while (!h.payoutsAllocated()) h.allocatePayout(32);
        uint256 reserveDustQ = h.reserveResidualQ() % 1e18;
        while (!h.claimsEnabled()) h.prepareReserve(32);
        // Reserve-treasury escrow should hold only reserve-owned dust; the protocol fee is a
        // separate beneficiary-owned liability, held in the vault's global fee escrow (A-I01).
        assertEq(h.treasuryQ(), reserveDustQ, "protocol fee folded into reserve treasury escrow");
        assertEq(vault.feeEscrowQ(address(0x777)), 2e18);
        assertEq(h.reclassifiedProtocolFeeQ(), 2e18);
        assertEq(h.protocolFeeQ(), 0);
        vm.prank(address(0x777));
        assertEq(vault.withdrawFees(), 2);
        assertEq(vault.feeEscrowQ(address(0x777)), 0);
        assertEq(h.treasuryQ(), reserveDustQ);
        assertEq(vault.freeAtoms(address(0x777)), 2);
    }

    function _fund(MockUSDC token, CollateralVault vault, AccountingHarness h, address u, uint256 a, bool r)
        internal
    {
        token.mint(u, a);
        vm.startPrank(u);
        token.approve(address(vault), a);
        vault.deposit(a);
        vault.allocate(address(h), a, r);
        vm.stopPrank();
    }
}
