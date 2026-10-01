// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AccountingHarness} from "../../harness/A/AccountingHarness.sol";
import {MockRiskDecision} from "../../mocks/A/MockRiskDecision.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";

/// @notice Reproducer for audit finding A-F01 (docs/merge/A-audit.md). Expected to FAIL until fixed.
/// Trader and reserve-seed allocations made before activation have no exit path once T passes
/// without activation: release needs an active market, activation needs now < T, and the
/// halt/claims path needs an active market.
contract FindingAF01PreActivationLockTest is Test {
    function testPreActivationAllocationsCanExitAfterT() public {
        vm.warp(86_400);
        MockUSDC token = new MockUSDC();
        CollateralVault vault = new CollateralVault(address(token), address(this));
        MockRiskDecision decision = new MockRiskDecision();
        uint64 t = uint64(block.timestamp + 10 days);
        AccountingHarness h = new AccountingHarness(vault, decision, address(0x777), t, false, false);
        vault.registerEngine(address(h));
        address alice = address(0xA11CE);
        decision.set(alice, true);
        token.mint(alice, 100e6);
        vm.startPrank(alice);
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vault.allocate(address(h), 100e6, false);
        vm.stopPrank();

        vm.warp(t + 1);
        bool exit;
        vm.prank(alice);
        try h.release(100e6) {
            exit = true;
        } catch {}
        try h.activate(0, P.Tariff(0, 0, 0)) {
            exit = true;
        } catch {}
        try h.freeze(t) {
            exit = true;
        } catch {}
        assertTrue(exit, "no exit path for pre-activation allocation after T");
    }
}
