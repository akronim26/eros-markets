// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {AccountingHarness} from "../harness/A/AccountingHarness.sol";
import {MockRiskDecision} from "../mocks/A/MockRiskDecision.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {QMath} from "../../src/math/QMath.sol";
import {PremiumMath as P} from "../../src/math/PremiumMath.sol";

/// @notice Phase 1 audit: Person A's real stateful modules (test-only AccountingHarness) driven
///         through the spec's worked scenarios. B decisions come from A's scripted
///         MockRiskDecision (allow-all for the named accounts), so B admission/margin rules are
///         NOT exercised here; these tests check A's ledger, coverage, funding, premium, takeover,
///         custody and settlement arithmetic only.
contract AuditStatefulTest is Test {
    uint256 constant Q = 1e18;
    AccountingHarness h;
    MockRiskDecision decision;
    MockUSDC token;
    CollateralVault vault;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address dave = address(0xDA7E);
    address lp = address(0xCAFE);
    address lp2 = address(0xCAFF);
    address keeper = address(0xBEEF);
    address treasury = address(0x777);

    function _deploy(uint256 seedAtoms, bool recovery, bool funding, P.Tariff memory t) internal {
        vm.warp(86_400); // hour boundary: first epoch is a full hour
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        decision = new MockRiskDecision();
        h = new AccountingHarness(vault, decision, treasury, uint64(block.timestamp + 10 days), recovery, funding);
        vault.registerEngine(address(h));
        _fund(lp, seedAtoms, true);
        _fund(alice, 120e6, false);
        _fund(bob, 100e6, false);
        decision.set(alice, true);
        decision.set(bob, true);
        decision.set(carol, true);
        decision.set(dave, true);
        h.activate(0, t);
    }

    function _fund(address user, uint256 atoms, bool reserve_) internal {
        token.mint(user, atoms);
        vm.startPrank(user);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(h), atoms, reserve_);
        vm.stopPrank();
    }

    function _zero() internal pure returns (P.Tariff memory) {
        return P.Tariff(0, 0, 0);
    }

    function _epoch() internal view returns (uint64 id, uint64 start, uint64 end, uint64 last, uint64 stop, int256 rate, bool stopped) {
        return h.epoch();
    }

    function _cash(address who) internal view returns (int256) {
        return h.account(who).value.cashQ;
    }

    /// INV-01, INV-02 (virtual cash form), INV-03, INV-04 on the live ledger.
    function _assertInvariants() internal view {
        (int128 rn, int256 rc) = h.reserve();
        int256 n = rn;
        int256 cash = rc;
        for (uint256 i; i < h.participantCount(); i++) {
            RiskStorage.Account memory a = h.account(h.participants(i));
            n += a.value.lots;
            cash += a.value.cashQ;
        }
        assertEq(n, 0, "INV-01");
        assertEq(cash + int256(h.protocolFeeQ() + h.keeperPayableQ()) + h.fundingClearingQ(), int256(h.allocationQ()), "INV-02");
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms(), "INV-03");
        assertEq(vault.marketAtoms(address(h)) * Q, h.allocationQ(), "market atoms");
        (int256 s0, int256 s1) = h.coverageSlacks();
        assertGe(s0, 0, "INV-04 NO");
        assertGe(s1, 0, "INV-04 YES");
    }

    // ---- Two-wallet case: reserve requirement is the per-outcome max (480), not the sum (780).

    function testTwoWalletReserve480Suffices() public {
        _deploy(480e6, false, false, _zero());
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        assertEq(_cash(alice), -480_000_000e18);
        assertEq(_cash(bob), 700_000_000e18);
        (int256 s0, int256 s1) = h.coverageSlacks();
        assertEq(s0, 0); // R0 480 - D0 480
        assertEq(s1, 180_000_000e18); // R1 480 - D1 300
        assertEq(h.allocationQ(), 700_000_000e18); // 480 + 120 + 100 USDC
        _assertInvariants();
    }

    function testTwoWalletReserveBelow480Rejected() public {
        _deploy(479_999_999, false, false, _zero());
        vm.expectRevert(RiskStorage.Coverage.selector);
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
    }

    // ---- Section 11 bilateral position through NO, YES and INVALID(0.5), page sizes 1 and 32,
    //      both claim orders. Market cash is 100,220 USDC throughout.

    function _settle(uint256 price, uint8 page) internal {
        h.freeze(uint64(block.timestamp));
        h.finalPrice(price, bytes32(uint256(1)));
        while (!h.snapshotComplete()) h.snapshotPage(page);
        while (!h.payoutScanComplete()) h.scanPayout(page);
        while (!h.payoutsAllocated()) h.allocatePayout(page);
        while (!h.claimsEnabled()) h.prepareReserve(page);
    }

    function _bilateral(uint256 price, uint8 page, bool aliceFirst, uint256 wantA, uint256 wantB, uint256 wantReserve)
        internal
    {
        _deploy(100_000e6, false, false, _zero());
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        assertEq(h.allocationQ(), 100_220e6 * Q);
        _assertInvariants();
        vm.warp(block.timestamp + 60);
        _settle(price, page);
        assertEq(h.traderAtoms(alice), wantA);
        assertEq(h.traderAtoms(bob), wantB);
        assertEq(h.reserveResidualQ(), wantReserve * Q);
        address first = aliceFirst ? alice : bob;
        address second = aliceFirst ? bob : alice;
        uint256 b1 = token.balanceOf(first);
        if (h.traderAtoms(first) != 0) h.claimTrader(first);
        assertEq(token.balanceOf(first) - b1, h.traderAtoms(first));
        uint256 b2 = token.balanceOf(second);
        if (h.traderAtoms(second) != 0) h.claimTrader(second);
        assertEq(token.balanceOf(second) - b2, h.traderAtoms(second));
        // INV-09: paid once.
        if (h.traderAtoms(first) != 0) {
            vm.expectRevert(CollateralVault.BadUnits.selector);
            h.claimTrader(first);
        }
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }

    function testBilateralNO_page1_aliceFirst() public {
        _bilateral(0, 1, true, 0, 700e6, 99_520e6);
    }

    function testBilateralNO_page32_bobFirst() public {
        _bilateral(0, 32, false, 0, 700e6, 99_520e6);
    }

    function testBilateralYES_page1_bobFirst() public {
        _bilateral(1e18, 1, false, 520e6, 0, 99_700e6);
    }

    function testBilateralYES_page32_aliceFirst() public {
        _bilateral(1e18, 32, true, 520e6, 0, 99_700e6);
    }

    function testBilateralINVALID_page1_aliceFirst() public {
        _bilateral(5e17, 1, true, 20e6, 200e6, 100_000e6);
    }

    function testBilateralINVALID_page32_bobFirst() public {
        _bilateral(5e17, 32, false, 20e6, 200e6, 100_000e6);
    }

    // ---- Claims gate (INV-09): finality/price alone and partial allocation never enable claims.

    function testClaimsNotEnabledBeforeAllocation() public {
        _deploy(100_000e6, false, false, _zero());
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        h.freeze(uint64(block.timestamp));
        h.finalPrice(0, bytes32(uint256(1)));
        assertFalse(h.claimsEnabled());
        vm.expectRevert(RiskStorage.BadState.selector);
        h.claimTrader(bob);
        while (!h.snapshotComplete()) h.snapshotPage(1);
        h.scanPayout(1);
        assertFalse(h.claimsEnabled());
        // A conflicting final price cannot replace the accepted one.
        vm.expectRevert(RiskStorage.BadState.selector);
        h.finalPrice(1e18, bytes32(uint256(1)));
    }

    // ---- Premium (DEC-03): neutral touches agree with one delayed touch; 4x on a new deficit.

    function testPremiumNeutralTouchStateful() public {
        _deploy(100_000e6, false, false, P.Tariff(1e14, 1e14, 1e18));
        _fund(carol, 120e6, false);
        _fund(dave, 100e6, false);
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        h.trade(carol, dave, 1_000_000, 600, 0, 0);
        assertGt(h.account(alice).surchargeUntil, 0); // fresh principal deficit -> 4x period
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1800);
        h.sync(alice);
        vm.warp(t0 + 3500);
        h.sync(alice);
        h.sync(carol);
        assertEq(_cash(alice), _cash(carol));
        assertLt(_cash(alice), -480_000_000e18); // premium was charged
        // Bob (short, YES deficit 300) also pays; the reserve receives exactly what traders paid.
        h.sync(bob);
        (, int256 rc) = h.reserve();
        int256 paid = (-480_000_000e18 - _cash(alice)) + (700_000_000e18 - _cash(bob)) + (-480_000_000e18 - _cash(carol));
        assertGt(700_000_000e18 - _cash(bob), 0);
        assertEq(rc - int256(100_000e6 * Q), paid);
        _assertInvariants();
    }

    function testPremiumCapitalizedAtRollover() public {
        _deploy(100_000e6, false, false, P.Tariff(1e14, 1e14, 1e18));
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        (,, uint64 end,,,,) = _epoch();
        vm.warp(end);
        h.beginRoll();
        while (h.cursor() < h.sweepCount()) h.rollPage(32);
        RiskStorage.Account memory a = h.account(alice);
        assertEq(a.premiumPaid, 0);
        assertEq(a.segmentCash, a.value.cashQ); // next base includes the completed epoch's premium
        assertLt(a.value.cashQ, -480_000_000e18);
        assertEq(h.fundingClearingQ(), 0);
        assertEq(h.fundingCushionQ(), 0);
    }

    // ---- Funding (DEC-02): OI=0 epoch stays off; budget consumed by old then new OI; one stop.

    function testFundingEpochBudgetAndStop() public {
        _deploy(100_000e6, false, true, _zero());
        (,,,,,, bool stopped) = _epoch();
        assertTrue(stopped); // initial zero OI disables the whole epoch
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        int256 f0 = h.fundingFQ();
        vm.warp(block.timestamp + 600);
        h.sync(alice);
        assertEq(h.fundingFQ(), f0); // no authorization created by the first trade

        int256 r = 1e12; // Q per lot per second
        (,, uint64 end,,,,) = _epoch();
        vm.warp(end);
        h.beginRoll();
        while (h.cursor() < h.sweepCount()) h.rollPage(32);
        h.finishRoll(r, _zero());
        (, uint64 start, uint64 end2,,,,) = _epoch();
        uint256 budget = h.fundingBudgetQ();
        assertEq(budget, 1_000_000 * uint256(r) * (end2 - start));

        _fund(carol, 1_000e6, false);
        _fund(dave, 1_000e6, false);
        vm.warp(start + 20);
        h.trade(carol, dave, 1_000_000, 500, 0, 0); // OI 1e6 -> 2e6 after accruing old OI
        assertEq(h.fundingBudgetQ(), budget - 1_000_000 * uint256(r) * 20);
        uint256 affordable = h.fundingBudgetQ() / (2_000_000 * uint256(r));
        vm.warp(start + 20 + affordable + 100);
        h.sync(alice);
        (,,, uint64 last, uint64 stop,, bool stoppedNow) = _epoch();
        assertTrue(stoppedNow);
        assertEq(last, start + 20 + affordable);
        assertEq(stop, last);
        int256 fStop = h.fundingFQ();
        vm.warp(block.timestamp + 200);
        h.sync(bob);
        assertEq(h.fundingFQ(), fStop); // a stopped epoch never restarts
        _assertInvariants();
    }

    function testFundingFeatureFlagRejectsRate() public {
        _deploy(100_000e6, false, false, _zero());
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        (,, uint64 end,,,,) = _epoch();
        vm.warp(end);
        h.beginRoll();
        while (h.cursor() < h.sweepCount()) h.rollPage(32);
        vm.expectRevert(RiskStorage.Rejected.selector);
        h.finishRoll(1e12, _zero());
    }

    // ---- Takeover (DEC-13): positive equity is never taken; whole account moves, no fee.

    function testTakeoverEligibilityWholeAccountNoFee() public {
        _deploy(100_000e6, false, false, _zero());
        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        vm.expectRevert(RiskStorage.Rejected.selector);
        h.takeover(alice); // mark 0.60: equity 120 > 0
        (int256 s0Before, int256 s1Before) = h.coverageSlacks();
        h.setContext(uint64(block.timestamp + 30 days), 0.48e18, true); // equity exactly 0
        uint256 feesBefore = h.protocolFeeQ() + h.keeperPayableQ();
        h.takeover(alice);
        (int128 rn, int256 rc) = h.reserve();
        assertEq(rn, 1_000_000);
        assertEq(rc, 100_000e6 * int256(Q) - 480_000_000e18);
        assertEq(h.account(alice).value.lots, 0);
        assertEq(h.account(alice).value.cashQ, 0);
        assertEq(h.protocolFeeQ() + h.keeperPayableQ(), feesBefore);
        (int256 s0, int256 s1) = h.coverageSlacks();
        assertEq(s0 - s0Before, 0); // max(e0 = -480, 0)
        assertEq(s1 - s1Before, 520_000_000e18); // max(e1 = 520, 0)
        assertTrue(h.registered(alice)); // registry never deletes
        _assertInvariants();
    }

    // ---- Custody.

    function testFeeOnTransferTokenRejected() public {
        _deploy(100_000e6, false, false, _zero());
        token.configure(address(0), true);
        token.mint(carol, 10e6);
        vm.startPrank(carol);
        token.approve(address(vault), 10e6);
        vm.expectRevert(CollateralVault.TransferFailed.selector);
        vault.deposit(10e6);
        vm.stopPrank();
    }

    function testNoPublicLedgerMutatorFromNonVault() public {
        _deploy(100_000e6, false, false, _zero());
        vm.expectRevert(RiskStorage.Unauthorized.selector);
        h.onAllocate(alice, 1);
        vm.expectRevert(RiskStorage.Unauthorized.selector);
        h.onReserveAllocate(alice, 1);
    }

    // ---- Bounds.

    function testRegistryCapAndBatchBound() public {
        _deploy(100_000e6, false, false, _zero());
        for (uint160 i = 1; h.participantCount() < 1024; i++) h.registerOnly(address(i + 1000));
        vm.expectRevert(RiskStorage.BadState.selector);
        h.registerOnly(address(0x123456));
        (,, uint64 end,,,,) = _epoch();
        vm.warp(end);
        h.beginRoll();
        vm.expectRevert(RiskStorage.BadState.selector);
        h.rollPage(33);
    }

    function testCashBoundEnforced() public {
        _deploy(100_000e6, false, false, _zero());
        uint256 atoms = (uint256(1) << 180) / Q + 1;
        token.mint(carol, atoms);
        vm.startPrank(carol);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vm.expectRevert(QMath.Bounds.selector);
        vault.allocate(address(h), atoms, false);
        vm.stopPrank();
    }

    // ---- Recovery off by construction flag; reserve shares only before activation (DEC-06).

    function testRecoveryDisabledFlag() public {
        _deploy(100_000e6, false, false, _zero());
        assertFalse(h.recoveryEnabled());
        assertFalse(h.fundingFeatureEnabled());
    }

    function testNoShareIssuanceAfterActivationAndNoticeGate() public {
        _deploy(100_000e6, false, false, _zero());
        uint256 sharesBefore = h.reserveVault().totalShares();
        (, int256 rcBefore) = h.reserve();
        _fund(lp2, 1_000e6, true); // donation after activation
        assertEq(h.reserveVault().totalShares(), sharesBefore);
        assertEq(h.reserveVault().shares(lp2), 0);
        (, int256 rc) = h.reserve();
        assertEq(rc - rcBefore, int256(1_000e6 * Q));

        h.trade(alice, bob, 1_000_000, 600, 0, 0);
        address rv = address(h.reserveVault());
        vm.prank(lp);
        (bool ok,) = rv.call(abi.encodeWithSignature("notice()"));
        assertTrue(ok);
        _settle(0, 32);
        vm.expectRevert(); // notice not matured
        h.redeemReserve(lp);
        vm.warp(block.timestamp + 7 days);
        uint256 lpAtoms = h.redeemReserve(lp);
        assertEq(lpAtoms, 100_520e6); // 101,220 market cash - 700 claim
        // Trader claim still pays its fixed entitlement after the LP exit.
        uint256 b = token.balanceOf(bob);
        h.claimTrader(bob);
        assertEq(token.balanceOf(bob) - b, 700e6);
        vault.claim(address(h), lp);
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }
}
