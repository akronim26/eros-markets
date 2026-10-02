// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {AccountingHarness} from "../../harness/A/AccountingHarness.sol";
import {MockRiskDecision} from "../../mocks/A/MockRiskDecision.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {RiskStorage} from "../../../src/risk/RiskStorage.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";
import {CoverageMath as C} from "../../../src/math/CoverageMath.sol";

abstract contract AccountingTestBase is Test {
    AccountingHarness h;
    MockRiskDecision decision;
    MockUSDC token;
    CollateralVault vault;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address lp = address(0xCAFE);
    address keeper = address(0xBEEF);
    address treasury = address(0x777);
    uint64 end;

    function setUp() public virtual {
        vm.warp(86401);
        end = uint64(block.timestamp + 10 days);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        decision = new MockRiskDecision();
        h = new AccountingHarness(vault, decision, treasury, end, false, true);
        vault.registerEngine(address(h));
        _fund(lp, 100000e6, true);
        _fund(alice, 120e6, false);
        _fund(bob, 100e6, false);
        decision.set(alice, true);
        decision.set(bob, true);
        h.activate(0, P.Tariff(0, 0, 0));
    }

    function _fund(address user, uint256 atoms, bool reserve_) internal {
        token.mint(user, atoms);
        vm.startPrank(user);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(h), atoms, reserve_);
        vm.stopPrank();
    }

    function _trade() internal {
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
    }

    function _epochEnd() internal view returns (uint64 e) {
        (,, e,,,,) = h.epoch();
    }

    function _roll(int256 rate, P.Tariff memory t) internal {
        vm.warp(_epochEnd());
        h.beginRoll();
        while (h.cursor() < h.sweepCount()) h.rollPage(32);
        h.finishRoll(rate, t);
    }

    function _finish(uint256 price, uint8 page) internal {
        h.freeze(uint64(block.timestamp));
        h.finalPrice(price, bytes32(uint256(1)));
        while (!h.snapshotComplete()) h.snapshotPage(page);
        while (!h.payoutScanComplete()) h.scanPayout(page);
        while (!h.payoutsAllocated()) h.allocatePayout(page);
        while (!h.claimsEnabled()) h.prepareReserve(page);
    }

    function _assertLedger() internal view {
        (int128 rn, int256 rc) = h.reserve();
        int256 n = rn;
        int256 cash = rc;
        uint256 count = h.participantCount();
        for (uint256 i; i < count; i++) {
            RiskStorage.Account memory a = h.account(h.participants(i));
            n += a.value.lots;
            cash += a.value.cashQ;
        }
        assertEq(n, 0);
        assertEq(
            cash + int256(h.protocolFeeQ() + h.keeperPayableQ()) + h.fundingClearingQ(),
            int256(h.allocationQ())
        );
        (int256 s0, int256 s1) = h.coverageSlacks();
        assertGe(s0, 0);
        assertGe(s1, 0);
        assertEq((vault.marketAtoms(address(h)) * 1e18 - vault.marketDebitQ(address(h))), h.allocationQ());
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }
}
