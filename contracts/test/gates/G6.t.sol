// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {SettlementController} from "../../src/settlement/SettlementController.sol";
import {ReserveVault} from "../../src/vaults/ReserveVault.sol";
import {IAccountingPort} from "../../src/interfaces/IAccountingPort.sol";
import {SettlementView} from "../../src/interfaces/IResolutionIngress.sol";
import {LifecycleMath} from "../../src/math/LifecycleMath.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode, ClearingPhase} from "../../src/math/RiskTypes.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";

/// @notice G6 — resolution to cash joined: real B finality / INVALID capture / settlement
///         controller over real A snapshot, payout, escrow, claims and reserve exit.
contract G6Test is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;
    uint8 constant ORACLE_YES = 1;
    uint8 constant ORACLE_NO = 2;
    uint8 constant ORACLE_INVALID = 3;

    /// Section 11 bilateral fixture under NORMAL_PRICING: Alice 120 long, Bob 100 short, 1000 claims at .60.
    function _bilateral() internal {
        _bilateralWith(120);
    }

    function _bilateralWith(uint256 aliceUsdc) internal {
        _deploy(5, 100_000);
        uint256[] memory u = new uint256[](2);
        (u[0], u[1]) = (aliceUsdc, 100);
        _traders(u);
        ReserveVault rv = e.reserveVault();
        vm.prank(LP);
        rv.notice(); // LP gives its 7-day notice early
        _activate();
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        assertEq(_cash(1), int256(aliceUsdc * USDC) - int256(600 * USDC) - int256(e.protocolFeeQ()));
        assertEq(_cash(2), int256(700 * USDC));
        assertEq(e.allocationQ(), (100_100 + aliceUsdc) * USDC);
    }

    function _prepare(uint8 page) internal {
        while (!e.prepareSnapshotChunk(page).done) {}
        while (!e.preparePayoutChunk(page).done) {}
        assertTrue(e.finishPreparation());
    }

    function _expectedAtoms(address who, uint256 priceWad) internal view returns (uint256) {
        (int128 lots, int256 cash) = e.frozen(who);
        int256 v = cash + int256(lots) * 1000 * int256(priceWad);
        return v > 0 ? uint256(v) / 1e18 : 0;
    }

    function _claimAll(bool aliceFirst, uint256 priceWad) internal {
        address[2] memory who = aliceFirst ? [_who(1), _who(2)] : [_who(2), _who(1)];
        for (uint256 i; i < 2; ++i) {
            uint256 want = _expectedAtoms(who[i], priceWad);
            assertEq(e.traderAtoms(who[i]), want, "allocated entitlement = frozen value at price");
            if (want == 0) continue;
            uint256 b = token.balanceOf(who[i]);
            e.claimTrader(who[i]);
            assertEq(token.balanceOf(who[i]) - b, want);
            vm.expectRevert(CollateralVault.BadUnits.selector);
            e.claimTrader(who[i]); // once only
        }
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms(), "INV-03");
        assertTrue(e.allTraderClaimsPaid(), "zero-atom entitlements do not prevent completion");
    }

    function _common(uint256 priceWad) internal view {
        // Every Q stays classified: LP atoms outstanding + treasury Q + keeper Q == market allocation.
        assertEq(
            e.outstandingReserveAtoms() * 1e18 + e.treasuryQ() + e.protocolFeeEscrowQ() + e.keeperPayableQ(),
            e.allocationQ()
        );
        assertEq(e.conversionEligibility(), e.R_DISABLED(), "conversion stays disabled");
        assertFalse(e.recoveryEnabled(), "recovery disabled");
        assertTrue(e.claimsEnabled());
        assertEq(e.settlementPriceWad(), priceWad);
    }

    // ------------------------------------------------------------------------------------------

    function test_NO_pages1_aliceFirst_lpRedeemsBeforeClaims() public {
        _bilateral();
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        assertTrue(oracle.finalize(ORACLE_NO));
        assertFalse(oracle.finalize(ORACLE_NO), "identical repeat: no new acceptance");
        assertFalse(e.claimsEnabled(), "finality alone is not claimable");
        _prepare(1);
        _common(0);
        assertEq(e.traderAtoms(_who(1)), 0);
        assertGt(e.traderAtoms(_who(2)), 699e6);
        // LP redeems first (after notice maturity), traders claim afterwards.
        vm.warp(block.timestamp + 7 days);
        uint256 lpAtoms = e.redeemReserve(LP);
        assertGt(lpAtoms, 99_519e6);
        vault.claim(address(e), LP);
        _claimAll(true, 0);
        _common(0);
    }

    function test_YES_pages32_bobFirst() public {
        _bilateral();
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        assertTrue(oracle.finalize(ORACLE_YES));
        vm.expectRevert();
        oracle.finalize(ORACLE_NO); // conflicting finality cannot replace the outcome
        _prepare(32);
        _common(1e18);
        assertGt(e.traderAtoms(_who(1)), 519e6);
        assertLe(e.traderAtoms(_who(1)), 520e6);
        _claimAll(false, 1e18);
        // Retries after completion are no-ops.
        assertTrue(e.prepareSnapshotChunk(1).done);
        assertTrue(e.finishPreparation());
    }

    function test_earlyINVALID_waitsThenCapturesTwap() public {
        _bilateral();
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        assertTrue(oracle.finalize(ORACLE_INVALID));
        while (!e.prepareSnapshotChunk(1).done) {}
        vm.expectRevert(SettlementController.OutcomeOrPricePending.selector);
        e.preparePayoutChunk(1);
        SettlementView memory v = e.getSettlementStatus();
        assertFalse(v.invalidPriceReady);
        // The independent index recorder continues; the scheduled [T-24h, T] window completes.
        e.feedIndex(T - 86_400 - 20, T + 300, 20, 55e16, 0, 0);
        vm.warp(T);
        (LifecycleMath.InvalidReadiness s, bool captured) = e.captureInvalidPrice();
        assertTrue(captured);
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.CAPTURE_TWAP));
        while (!e.preparePayoutChunk(1).done) {}
        assertTrue(e.finishPreparation());
        _common(55e16);
        _claimAll(true, 55e16);
    }

    function test_earlyINVALID_missingDataFallback() public {
        _bilateral();
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        assertTrue(oracle.finalize(ORACLE_INVALID));
        e.feedIndex(T - 86_400 - 20, T + 300, 20, 55e16, T - 50_000, T - 49_900); // 100 s gap
        vm.warp(T + 3599);
        (, bool c) = e.captureInvalidPrice();
        assertFalse(c, "grace hour not over");
        vm.warp(T + 3600);
        (LifecycleMath.InvalidReadiness s, bool captured) = e.captureInvalidPrice();
        assertTrue(captured);
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.CAPTURE_FALLBACK));
        _prepare(32);
        _common(5e17);
        // Section 11 at p = 0.5: Alice ~20, Bob ~200 USDC (less premium posted at the halt touch).
        assertGt(e.traderAtoms(_who(1)), 19e6);
        assertEq(e.traderAtoms(_who(2)), _expectedAtoms(_who(2), 5e17));
        _claimAll(false, 5e17);
    }

    /// Finality acceptance does no per-account work: same gas with 2 and 34 participants.
    function test_finalityIsConstantWork() public {
        _bilateral();
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        uint256 g0 = gasleft();
        oracle.finalize(ORACLE_NO);
        uint256 small = g0 - gasleft();

        _bilateral();
        for (uint32 i = 3; i <= 34; ++i) {
            _fund(_who(i), 1e6, false);
        }
        assertEq(e.participantCount(), 34);
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        g0 = gasleft();
        oracle.finalize(ORACLE_NO);
        uint256 large = g0 - gasleft();
        emit log_named_uint("finalize gas, 2 accounts", small);
        emit log_named_uint("finalize gas, 34 accounts", large);
        assertEq(large, small);
    }

    function test_feeFractionStaysClassified() public {
        _variant = 1; // 0.1% taker fee
        _bilateralWith(121);
        uint256 fee0 = e.protocolFeeQ();
        assertEq(fee0, 1_000_000 * 600 * 1e15, "Alice's taker fee");
        // A one-lot trade leaves a sub-atom fee: Bob buys 1 lot back from Alice at 0.600.
        e.rest(1, SELL, 600, 1);
        assertEq(e.place(_ioc(2, BUY, 600, 1)).filledLots, 1);
        assertEq(e.protocolFeeQ() - fee0, 600e15, "0.6-atom fee in Q");
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        oracle.finalize(ORACLE_YES);
        _prepare(32);
        _common(1e18);
        uint256 protocolFees = e.protocolFeeEscrowQ();
        uint256 reserveDust = e.treasuryQ();
        assertEq(protocolFees, fee0 + 600e15);
        uint256 atoms = e.withdrawProtocolFees();
        assertEq(atoms, protocolFees / 1e18);
        assertEq(e.protocolFeeEscrowQ(), protocolFees % 1e18, "fraction retained");
        assertEq(e.treasuryQ(), reserveDust, "reserve dust remains separate");
        _common(1e18);
    }
}
