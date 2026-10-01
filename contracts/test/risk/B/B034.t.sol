// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ResolutionIngress} from "../../../src/settlement/ResolutionIngress.sol";
import {RiskContextPort} from "../../../src/risk/RiskContextPort.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {IResolutionEngine, HaltView, SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {AdmissionMode, Stage} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract IngressEngine is ResolutionIngress, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function getSettlementStatus() external view virtual returns (SettlementView memory v) {
        v.halted = _halt.halted;
        v.finalOutcome = _finalOutcome;
        v.oracleFinalityAccepted = _finalOutcome != MathTypes.FinalOutcome.UNSET;
    }
}

/// B034: authenticated immutable finality ingress (scripted A freeze port, mock oracle authority).
contract B034Test is Test {
    uint256 constant USDC = 1e24;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    IngressEngine e;
    MockResolutionAuthority oracle;

    function setUp() public {
        vm.warp(L0);
        oracle = new MockResolutionAuthority();
        e = new IngressEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 10 days;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        oracle.bind(e);
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        e.mockSetAccount(1, int256(100 * USDC), 0);
        e.mockScriptFreeze(
            IAccountingPort.FreezeResult(
                0, 0, 3_000_000, int256(7), 4, 0, keccak256("tariff"), keccak256("state")
            )
        );
    }

    function test_unauthorizedActorsFail() public {
        address[3] memory who = [address(0x30), address(0x60), address(0xBAD)];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
            e.halt();
            vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
            e.settle(1);
            vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
            e.settleInvalid();
            vm.stopPrank();
        }
    }

    function test_earlyHaltOnceAndIdempotent() public {
        vm.warp(L0 + 2 days);
        HaltView memory h = oracle.haltEarly();
        assertTrue(h.halted);
        assertEq(h.economicHaltAt, L0 + 2 days);
        assertEq(h.oiHaltLots, 3_000_000, "OI from A's freeze, reported in lots");
        assertEq(uint8(e.currentStage()), uint8(Stage.HALTED));
        vm.warp(L0 + 3 days);
        HaltView memory again = oracle.haltEarly();
        assertEq(again.snapshotId, h.snapshotId);
        assertEq(again.economicHaltAt, h.economicHaltAt, "no deadline reset");
        assertEq(e.mockFreezeCount(), 1, "frozen once");
    }

    function test_scheduledHaltPermissionlessAtT() public {
        vm.expectRevert(ResolutionIngress.ScheduledHaltNotYet.selector);
        e.materializeScheduledHalt();
        vm.warp(T + 500); // late keeper
        vm.prank(address(0xBEEF));
        HaltView memory h = e.materializeScheduledHalt();
        assertEq(h.economicHaltAt, T, "economic halt at T, not the keeper's time");
        assertEq(h.haltRecordedAt, T + 500);
    }

    function test_settleLatchesOnceSameIdempotentConflictReverts() public {
        vm.warp(L0 + 5 days);
        assertTrue(oracle.finalize(1)); // YES; materializes the early halt first
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.YES));
        assertEq(e.getHaltSnapshot().economicHaltAt, L0 + 5 days);
        assertFalse(oracle.finalize(1), "same outcome: newlyAccepted false");
        vm.expectRevert(LifecycleMath.ConflictingFinalOutcome.selector);
        oracle.finalize(2);
        vm.expectRevert(LifecycleMath.ConflictingFinalOutcome.selector);
        oracle.finalize(3);
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.YES));
    }

    function test_onlyZeroOrOneY() public {
        vm.expectRevert(LifecycleMath.BadOutcome.selector);
        oracle.rawSettle(2);
        vm.expectRevert(LifecycleMath.BadOutcome.selector);
        oracle.rawSettle(255);
    }

    function test_failedDeliveryNotDropped() public {
        vm.warp(L0 + 5 days);
        oracle.finalize(2); // NO accepted
        oracle.storeExternalFinality(1); // a conflicting external result
        assertFalse(oracle.retryDelivery());
        assertTrue(oracle.hasPending(), "the failed delivery stays pending, not silently dropped");
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.NO));
    }

    function test_accrualCutoffUsesEpochAndRollover() public {
        e.mockSetEpochBounds(L0 + 2 days - 100, 0);
        vm.warp(L0 + 2 days);
        HaltView memory h = oracle.haltEarly();
        assertEq(h.economicHaltAt, L0 + 2 days);
        assertEq(h.accrualCutoff, L0 + 2 days - 100, "min(halt, epoch end)");
    }

    function test_haltDuringRolloverUsesFrozenCutoff() public {
        e.mockSetEpochBounds(L0 + 2 days + 3600, L0 + 2 days - 50);
        vm.warp(L0 + 2 days);
        HaltView memory h = oracle.haltEarly();
        assertEq(h.accrualCutoff, L0 + 2 days - 50);
    }

    function test_constantWorkFinality() public {
        vm.warp(L0 + 5 days);
        oracle.haltEarly();
        for (uint32 t = 10; t < 210; ++t) {
            e.mockSetAccount(t, 1, 0);
        }
        uint256 g0 = gasleft();
        oracle.finalize(1);
        uint256 used = g0 - gasleft();
        assertLt(used, 120_000, "no per-account work in settle");
        assertEq(e.mockFreezeCount(), 1);
    }
}
