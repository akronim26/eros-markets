// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SettlementController} from "../../../src/settlement/SettlementController.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {IAccountingPort} from "../../../provisional/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {AdmissionMode, ClearingPhase, FinalOutcome, Stage} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract SettleEngine is SettlementController, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function index(uint64 t, uint256 p) external {
        _onIndexObservation(t, p, true);
    }

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }
}

/// Shared settlement fixture for W6 suites.
abstract contract SettleFixture is Test {
    uint64 constant L0 = 1_000_000;
    uint64 T;
    SettleEngine e;
    MockResolutionAuthority oracle;

    function build() internal {
        vm.warp(L0);
        oracle = new MockResolutionAuthority();
        e = new SettleEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 10 days;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        oracle.bind(e);
        for (uint32 t = 1; t <= 5; ++t) {
            e.mockSetAccount(t, 1e24, 0);
        }
        e.mockScriptFreeze(
            IAccountingPort.FreezeResult(0, 0, 2_000_000, 0, 3, 0, keccak256("tariff"), keccak256("st"))
        );
        e.mockScriptFinish(IAccountingPort.FinishResult(true, false, 1_220_000_000, 480_000_000));
    }

    function feedFullWindow(uint256 p) internal {
        for (uint64 t = T - 86_400 - 20; t <= T; t += 20) {
            e.index(t, p);
        }
    }
}

/// B036: snapshot and preparation controller (scripted A settlement jobs).
contract B036Test is SettleFixture {
    function setUp() public {
        build();
    }

    function test_phasesDistinct() public {
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.LIVE));
        vm.warp(L0 + 5 days);
        oracle.haltEarly();
        SettlementView memory v = e.getSettlementStatus();
        assertEq(uint8(v.phase), uint8(ClearingPhase.HALTED));
        assertFalse(v.oracleFinalityAccepted);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.AWAITING_OUTCOME));
        oracle.finalize(1);
        v = e.getSettlementStatus();
        assertEq(uint8(v.phase), uint8(ClearingPhase.PREPARING));
        assertTrue(v.oracleFinalityAccepted);
        assertFalse(v.claimsEnabled, "oracle finality alone never enables claims");
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING));
        e.prepareSnapshotChunk(2);
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertEq(
            uint8(e.claimsStatus()),
            uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING),
            "not until finish"
        );
        assertTrue(e.finishPreparation());
        v = e.getSettlementStatus();
        assertEq(uint8(v.phase), uint8(ClearingPhase.READY));
        assertTrue(v.claimsEnabled);
        assertEq(v.totalTraderPayoutAtoms, 1_220_000_000);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
        assertEq(uint8(e.currentStage()), uint8(Stage.CLAIMS_READY));
        e.mockSetClaimState(true, true, false);
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.COMPLETE));
    }

    function test_invalidPricePendingBlocksPayouts() public {
        vm.warp(L0 + 5 days);
        oracle.haltEarly();
        oracle.finalize(3);
        e.prepareSnapshotChunk(32); // snapshot may run before the price
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING));
        vm.expectRevert(SettlementController.OutcomeOrPricePending.selector);
        e.preparePayoutChunk(32);
        feedFullWindow(42e16);
        vm.warp(T);
        e.captureInvalidPrice();
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertEq(e.getSettlementStatus().settlementPriceE18, 42e16);
    }

    function test_jobsRetryAfterInterruption() public {
        vm.warp(L0 + 5 days);
        oracle.finalize(2);
        e.prepareSnapshotChunk(2);
        e.mockFailChunkInBlock(block.number);
        vm.expectRevert(abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "interrupted chunk"));
        e.prepareSnapshotChunk(2);
        assertEq(e.getSettlementStatus().snapshotCursor, 2, "interrupted call left no partial progress");
        vm.roll(block.number + 1);
        e.prepareSnapshotChunk(2);
        e.prepareSnapshotChunk(2);
        assertTrue(e.getSettlementStatus().accountingComplete == false);
        e.preparePayoutChunk(5);
        assertTrue(e.getSettlementStatus().accountingComplete);
    }

    function test_claimsNeedReconciledLiabilities() public {
        e.mockScriptFinish(IAccountingPort.FinishResult(false, true, 0, 0));
        vm.warp(L0 + 5 days);
        oracle.finalize(1);
        vm.expectRevert(SettlementController.PreparationIncomplete.selector);
        e.finishPreparation();
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertFalse(e.finishPreparation());
        SettlementView memory v = e.getSettlementStatus();
        assertTrue(v.recoveryRequired);
        assertFalse(v.claimsEnabled);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.RECOVERY_REQUIRED));
    }

    function test_jobsNeedHaltAndBounds() public {
        vm.expectRevert(SettlementController.NotHalted.selector);
        e.prepareSnapshotChunk(1);
        vm.warp(T);
        e.materializeScheduledHalt();
        vm.expectRevert(SettlementController.BadChunk.selector);
        e.prepareSnapshotChunk(0);
        vm.expectRevert(SettlementController.BadChunk.selector);
        e.prepareSnapshotChunk(33);
    }

    function test_callbacksDoNoAccountWork() public {
        vm.warp(L0 + 5 days);
        uint256 n0 = e.mockCallCount();
        oracle.finalize(1);
        // finality: one FREEZE (+ market epoch bump), no snapshot/payout chunk, no touch
        for (uint256 i = n0; i < e.mockCallCount(); ++i) {
            (MockAccountingPort.CallKind k,,,,) = e.mockCalls(i);
            assertTrue(
                k == MockAccountingPort.CallKind.FREEZE || k == MockAccountingPort.CallKind.BUMP_MARKET_EPOCH
            );
        }
    }
}
