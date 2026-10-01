// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SettleEngine, SettleFixture} from "./B036.t.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {HaltView, SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {ClearingPhase} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// Resolution-to-claim campaign: real B ingress, INVALID capture and controller; scripted A
/// snapshot/payout/claim jobs; mock oracle authority. Each step asserts the deterministic status
/// (the next action a keeper/UI takes is implied by it).
abstract contract SettlementLifecycleCases is SettleFixture {
    function setUp() public {
        build();
    }

    function status() internal view returns (LifecycleMath.ClaimsStatus) {
        return e.claimsStatus();
    }

    function finishAll() internal {
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
    }

    function test_haltDuringRolloverKeepsFrozenCutoff() public {
        e.mockSetEpochBounds(L0 + 3 days, L0 + 2 days - 600); // rollover froze at the epoch end
        vm.warp(L0 + 2 days);
        HaltView memory h = oracle.haltEarly();
        assertEq(h.economicHaltAt, L0 + 2 days);
        assertEq(h.accrualCutoff, L0 + 2 days - 600, "adopts the frozen rollover cutoff");
        vm.warp(L0 + 4 days);
        oracle.finalize(1);
        assertEq(e.getHaltSnapshot().accrualCutoff, h.accrualCutoff, "no later call extends the cutoff");
    }

    function test_haltBeforeOrAfterRollSameCutoff() public {
        // roll-before-halt: frozen cutoff = epoch end; halt-before-roll: no frozen cutoff
        e.mockSetEpochBounds(L0 + 2 days - 600, L0 + 2 days - 600);
        vm.warp(L0 + 2 days);
        uint64 a = oracle.haltEarly().accrualCutoff;
        build();
        e.mockSetEpochBounds(L0 + 2 days - 600, 0);
        vm.warp(L0 + 2 days);
        uint64 b = oracle.haltEarly().accrualCutoff;
        assertEq(a, b);
    }

    function test_earlyInvalidDelayedWindowThenCapture() public {
        vm.warp(L0 + 2 days);
        oracle.finalize(3);
        assertEq(uint8(status()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING));
        e.prepareSnapshotChunk(32); // snapshot may complete early
        for (uint64 t = T - 86_420; t < T - 10_000; t += 20) {
            e.index(t, 4e17);
        }
        vm.warp(T);
        (LifecycleMath.InvalidReadiness s,) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.WAIT_GRACE), "window not yet complete");
        // delayed observations for the window arrive after T, still in observedAt order
        vm.warp(T + 100);
        for (uint64 t = T - 10_000; t <= T; t += 20) {
            e.index(t, 4e17);
        }
        (s,) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.CAPTURE_TWAP));
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertEq(e.getSettlementStatus().settlementPriceE18, 4e17);
        assertEq(uint8(status()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
    }

    function test_staleHistoryUsesDisclosedFallbackOnly() public {
        vm.warp(L0 + 2 days);
        oracle.finalize(3);
        for (uint64 t = T - 86_420; t <= T; t += 20) {
            if (t > T - 30_000 && t < T - 29_900) continue; // stale gap
            e.index(t, 4e17);
        }
        vm.warp(T + 3_599);
        (LifecycleMath.InvalidReadiness s, bool c) = e.captureInvalidPrice();
        assertFalse(c);
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.WAIT_GRACE));
        vm.warp(T + 3_600);
        (s, c) = e.captureInvalidPrice();
        assertTrue(c);
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.CAPTURE_FALLBACK));
        finishAll();
        assertEq(e.getSettlementStatus().settlementPriceE18, 5e17);
    }

    function test_duplicateDeliveryAndReplayNoSecondEffect() public {
        vm.warp(L0 + 2 days);
        assertTrue(oracle.finalize(2));
        HaltView memory h = e.getHaltSnapshot();
        assertFalse(oracle.finalize(2));
        oracle.haltEarly();
        assertEq(e.getHaltSnapshot().snapshotId, h.snapshotId);
        finishAll();
        uint256 calls = e.mockCallCount();
        assertTrue(e.finishPreparation(), "replay returns the latched result");
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertEq(e.mockCallCount(), calls, "completed jobs are not re-driven");
        vm.expectRevert(LifecycleMath.ConflictingFinalOutcome.selector);
        oracle.finalize(1);
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.NO));
    }

    function test_transientPreparationIssueKeepsOutcome() public {
        vm.warp(L0 + 2 days);
        oracle.finalize(1);
        e.mockFailChunkInBlock(block.number);
        vm.expectRevert(abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "interrupted chunk"));
        e.prepareSnapshotChunk(32);
        assertEq(
            uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.YES), "transient failure does not touch finality"
        );
        assertEq(uint8(status()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING));
        vm.roll(block.number + 1);
        finishAll();
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.READY));
    }

    function test_scheduledPathStatuses() public {
        vm.warp(T + 10);
        e.materializeScheduledHalt();
        assertEq(uint8(status()), uint8(LifecycleMath.ClaimsStatus.AWAITING_OUTCOME));
        e.prepareSnapshotChunk(32);
        oracle.finalize(1);
        assertEq(uint8(status()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING));
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertEq(uint8(status()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
    }
}
