// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SettleFixture} from "./B036.t.sol";
import {
    IResolutionEngine,
    HaltView,
    SettlementView,
    OracleOutcomeMap
} from "../../../src/interfaces/IResolutionIngress.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {RiskContextPort} from "../../../src/risk/RiskContextPort.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {ClearingPhase} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";

/// Oracle-team compatibility cases mirroring docs/counterpart-oracle-fixtures.json, run against
/// the real B engine (ResolutionIngress/InvalidPrice/SettlementController) through
/// MockResolutionAuthority. The A settlement jobs are scripted. Mock status: CP-ORACLE mocked.
abstract contract OracleCompatibilityCases is SettleFixture {
    /// Adapter-side conversion the oracle team uses for bond sizing (fixture rule).
    function exposureAtoms(uint256 oiHaltLots) internal pure returns (uint256) {
        return oiHaltLots * 1000;
    }

    function setUp() public {
        build();
        // positions: long 1,000 claims, short 1,500 claims, reserve long 500 claims
        e.mockSetAccount(1, 0, 1_000_000);
        e.mockSetAccount(2, 0, -1_500_000);
        e.mockSetReserve(0, 500_000);
        e.mockScriptFreeze(
            IAccountingPort.FreezeResult(0, 0, 0, 0, 3, 0, keccak256("tariff"), keccak256("st"))
        );
    }

    function test_oiIncludesReserveAndConvertsExplicitly() public {
        vm.warp(L0 + 2 days);
        HaltView memory h = oracle.haltEarly();
        assertEq(h.oiHaltLots, 1_500_000, "long 1,000,000 + reserve 500,000 = |short| 1,500,000 lots");
        assertEq(exposureAtoms(h.oiHaltLots), 1_500_000_000, "1,500 USDC in atoms");
        assertEq(
            e.getHaltSnapshot().oiHaltLots, h.oiHaltLots, "oracle reads the stored snapshot, not live OI"
        );
    }

    function test_enumMappingRows() public {
        (OracleOutcomeMap.EngineCall c, uint8 y) = OracleOutcomeMap.engineCallFor(1);
        assertEq(uint8(c), uint8(OracleOutcomeMap.EngineCall.SETTLE_BINARY));
        assertEq(y, 1);
        (c, y) = OracleOutcomeMap.engineCallFor(2);
        assertEq(y, 0);
        (c,) = OracleOutcomeMap.engineCallFor(4);
        assertEq(uint8(c), uint8(OracleOutcomeMap.EngineCall.SETTLE_INVALID));
        vm.warp(L0 + 2 days);
        oracle.finalize(1);
        assertEq(uint8(e.finalOutcome()), 2, "local YES = 2");
    }

    function test_scheduledLateKeeperClock() public {
        vm.warp(T + 500);
        HaltView memory h = oracle.requestScheduledHalt();
        assertEq(h.economicHaltAt, T, "Resolution.haltedAt must copy this, not the late tx time");
        assertEq(h.haltRecordedAt, T + 500);
    }

    function test_earlyBinaryDoesNotWaitForT() public {
        vm.warp(L0 + 2 days);
        oracle.finalize(2); // NO
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertLt(block.timestamp, T);
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.READY));
    }

    function test_earlyInvalidStaysPending() public {
        vm.warp(L0 + 2 days);
        oracle.finalize(4); // VOIDED -> INVALID
        SettlementView memory v = e.getSettlementStatus();
        assertTrue(v.oracleFinalityAccepted);
        assertFalse(v.invalidPriceReady);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING));
    }

    function test_deliveryRetriesAndDuplicates() public {
        vm.warp(L0 + 2 days);
        oracle.storeExternalFinality(1);
        assertTrue(oracle.retryDelivery());
        assertFalse(oracle.finalize(1), "duplicate is idempotent");
        vm.expectRevert(LifecycleMath.ConflictingFinalOutcome.selector);
        oracle.finalize(3);
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.YES));
    }

    function test_onlyPinnedOracle() public {
        vm.prank(address(0x30)); // monitor
        vm.expectRevert(RiskContextPort.Unauthorized.selector);
        IResolutionEngine(address(e)).settle(1);
        vm.prank(address(0x5555)); // keeper / arbitrary
        vm.expectRevert(RiskContextPort.Unauthorized.selector);
        IResolutionEngine(address(e)).halt();
    }
}
