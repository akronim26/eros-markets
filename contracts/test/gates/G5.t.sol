// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {RiskLiquidation} from "../../src/risk/RiskLiquidation.sol";
import {FloorLifecycle} from "../../src/risk/FloorLifecycle.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";
import {LiquidationMath as LM} from "../../src/math/LiquidationMath.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {RejectCode, PricingMode} from "../../src/math/RiskTypes.sol";
import {HaltView} from "../../src/interfaces/IResolutionIngress.sol";
import {MockBookAdapter} from "../mocks/B/MockBookAdapter.sol";

/// @notice G5 — liquidation and freeze joined: real B eligibility/book-close/pair/takeover/floor
///         controllers over real A takeover, fee, floor and freeze accounting.
contract G5Test is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;
    uint64 lastFeed;

    function _start(uint256[] memory usdc) internal {
        _deploy(5, 100_000);
        _traders(usdc);
        _activate();
        lastFeed = L0 - 1000;
        _advance(L0 + 12 hours, 6e17);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
    }

    /// Feed index and perp around `idx` up to `to` (no overlap), rolling an ended epoch.
    function _advance(uint64 to, uint256 idx) internal {
        uint64 from = to > 990 && to - 990 > lastFeed + 10 ? to - 990 : lastFeed + 10;
        vm.warp(to);
        e.feed(from, to, idx, idx - 1e16, idx + 1e16);
        lastFeed = to - ((to - from) % 10);
        if (block.timestamp >= _epochEnd()) _roll(32);
    }

    /// Move the price in steps of at most 0.05 every 20 minutes (below the 0.10 / 300 s trigger).
    function _walk(uint256 fromIdx, uint256 toIdx) internal {
        uint256 p = fromIdx;
        while (p != toIdx) {
            if (p > toIdx) p = p - toIdx > 5e16 ? p - 5e16 : toIdx;
            else p = toIdx - p > 5e16 ? p + 5e16 : toIdx;
            _advance(uint64(block.timestamp) + 20 minutes, p);
        }
        _advance(uint64(block.timestamp) + 20 minutes, toIdx);
    }

    function _status(uint32 id) internal view returns (MarginMath.Status) {
        return e.previewAccount(id).status;
    }

    function _liq(uint32 id, uint64 maxLots, uint16 exam, uint32 partner)
        internal
        returns (RiskLiquidation.LiquidationResult memory r)
    {
        vm.prank(KEEPER);
        r = e.liquidate(id, maxLots, exam, partner);
    }

    // ------------------------------------------------------------------------------------------

    function test_bookCloseNeedsMoreWorkKeeperFees() public {
        uint256[] memory u = new uint256[](3);
        (u[0], u[1], u[2]) = (120, 400, 1000);
        _start(u);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        _walk(6e17, 52e16);
        assertEq(uint8(_status(1)), uint8(MarginMath.Status.BELOW_MM));
        e.rest(3, BUY, 510, 1_000_000);
        (, int256 rc0) = e.reserve();

        // Tiny caller budget: partial close, NEEDS_MORE_WORK, never a positive-equity takeover.
        RiskLiquidation.LiquidationResult memory r = _liq(1, 10, 8, 0);
        assertEq(uint8(r.result), uint8(LM.Result.NEEDS_MORE_WORK));
        assertEq(r.bookLots, 10);
        assertEq(_lots(1), 1_000_000 - 10);
        assertEq(e.keeperQ(KEEPER), 5e18, "half of 10 atoms to the keeper, in Q");
        (, int256 rc1) = e.reserve();
        // Reserve receives the other half plus Alice's premium posted at the liquidation touch.
        assertGe(rc1 - rc0, 5e18, "other half to the reserve");
        assertEq(e.keeperPayableQ(), 5e18);
        _assertInvariants();

        // A real close reduces the position; health is not worse; still no takeover.
        r = _liq(1, 1_000_000, 64, 0);
        assertGt(r.bookLots, 0);
        assertTrue(r.result != LM.Result.TAKEOVER_AUTHORIZED);
        assertLt(_lots(1), 1_000_000 - 10);
        assertGt(e.previewAccount(1).markEquityQ, 0);
        _assertInvariants();

        // Keeper withdraws whole atoms only; the fractional Q stays a liability.
        uint256 kq = e.keeperQ(KEEPER);
        vm.prank(KEEPER);
        uint256 atoms = e.withdrawKeeper();
        assertEq(atoms, kq / 1e18);
        assertEq(e.keeperQ(KEEPER), kq % 1e18);
        _assertInvariants();
    }

    function test_pairReductionBothSidesEligible() public {
        uint256[] memory u = new uint256[](4);
        (u[0], u[1], u[2], u[3]) = (250, 800, 1000, 220);
        _start(u);
        e.rest(2, SELL, 600, 2_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 2_000_000)).filledLots, 2_000_000); // Alice long 2000 @ .60
        _walk(6e17, 5e17);
        e.rest(3, BUY, 500, 2_000_000);
        assertEq(e.place(_ioc(4, SELL, 500, 2_000_000)).filledLots, 2_000_000); // Dave short 2000 @ .50
        _walk(5e17, 5425e14); // equities ~135 each, both below MM (~140)
        assertEq(uint8(_status(1)), uint8(MarginMath.Status.BELOW_MM), "target eligible");
        assertEq(uint8(_status(4)), uint8(MarginMath.Status.BELOW_MM), "partner eligible");
        uint256 k0 = e.keeperQ(KEEPER);
        RiskLiquidation.LiquidationResult memory r = _liq(1, 1000, 8, 4);
        assertEq(r.pairedLots, 1000);
        assertEq(_lots(1), 2_000_000 - 1000);
        assertEq(_lots(4), -2_000_000 + 1000);
        uint256 charged = e.keeperQ(KEEPER) - k0;
        emit log_named_uint("pair keeper fee Q", charged);
        assertTrue(charged == 1000e18 || charged == 0, "A charges both sides or neither");
        _assertInvariants();
    }

    function test_authorizedTakeoverWholeAccountNoFee() public {
        uint256[] memory u = new uint256[](2);
        (u[0], u[1]) = (120, 400);
        _start(u);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        _walk(6e17, 47e16);
        assertLe(e.previewAccount(1).markEquityQ, 0);
        int256 cash1 = _cash(1);
        (int128 rl0, int256 rc0) = e.reserve();
        uint256 fees0 = e.keeperPayableQ() + e.protocolFeeQ();
        RiskLiquidation.LiquidationResult memory r = _liq(1, 1, 1, 0);
        assertEq(uint8(r.result), uint8(LM.Result.TAKEOVER_AUTHORIZED));
        (int128 rl1, int256 rc1) = e.reserve();
        assertEq(int256(rl1) - rl0, 1_000_000, "whole position to reserve");
        assertEq(rc1 - rc0, cash1, "whole cash to reserve");
        assertEq(_lots(1), 0);
        assertEq(_cash(1), 0);
        assertEq(e.keeperPayableQ() + e.protocolFeeQ(), fees0, "no takeover fee");
        _assertInvariants();
    }

    function test_floorSweepTakesOverDeficitsOnly() public {
        uint256[] memory u = new uint256[](3);
        (u[0], u[1], u[2]) = (120, 400, 50);
        _start(u);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        _advance(T - 12 hours + 60, 6e17);
        // Begin, then one page at a time: no live mutation inside the frozen sweep.
        assertEq(uint8(e.floorSweep(1)), uint8(FloorLifecycle.FloorStatus.SWEEPING));
        MockBookAdapter.PlaceResult memory pr = e.place(_ioc(3, BUY, 600, 10));
        assertEq(pr.filledLots, 0);
        vm.prank(_who(3));
        vm.expectRevert(RiskStorage.BadState.selector);
        e.release(1);
        while (e.floorSweep(1) != FloorLifecycle.FloorStatus.RECONCILED) {}
        assertTrue(e.fullBackingReconciled());
        assertEq(_lots(1), 0, "endpoint-deficit account taken over");
        assertEq(_lots(2), -1_000_000, "fully backed account kept");
        (int128 rl,) = e.reserve();
        assertEq(rl, 1_000_000);
        assertEq(e.fundingClearingQ(), 0);
        assertEq(e.fundingCushionQ(), 0);
        _assertInvariants();
    }

    function _haltDuringRollover(uint8 state) internal {
        uint256[] memory u = new uint256[](3);
        (u[0], u[1], u[2]) = (120, 400, 50);
        _start(u);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        uint64 end = _epochEnd();
        vm.warp(end + 30);
        if (state >= 1) e.beginRollover();
        if (state >= 2) e.rollPage(1);
        if (state >= 3) while (!e.rollPage(1)) {}
        oracle.haltEarly();
        HaltView memory h = e.getHaltSnapshot();
        assertTrue(h.halted);
        assertEq(h.economicHaltAt, end + 30, "actual halt time");
        assertEq(h.accrualCutoff, end, "shared accrual cutoff = epoch end");
        assertEq(e.accrualCutoff(), end);
        // No live mutation after the halt.
        assertEq(e.place(_ioc(3, BUY, 600, 10)).filledLots, 0);
        vm.prank(_who(3));
        vm.expectRevert(RiskStorage.BadState.selector);
        e.release(1);
        while (!e.prepareSnapshotChunk(1).done) {}
        assertTrue(e.snapshotComplete());
        assertEq(e.fundingClearingQ(), 0);
        (int128 fl, int256 fc) = e.frozen(_who(1));
        assertEq(fl, 1_000_000);
        assertEq(fc, _cash(1));
    }

    function test_haltBeforeRolloverBegins() public {
        _haltDuringRollover(0);
    }

    function test_haltAfterRolloverBeginBeforePages() public {
        _haltDuringRollover(1);
    }

    function test_haltMidRolloverPages() public {
        _haltDuringRollover(2);
    }

    function test_haltAfterAllPagesBeforeFinish() public {
        _haltDuringRollover(3);
    }
}
