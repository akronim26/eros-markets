// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LiqEngine} from "./B032.t.sol";
import {RiskLiquidation} from "../../../src/risk/RiskLiquidation.sol";
import {RiskView} from "../../../src/risk/RiskView.sol";
import {TradePreview} from "../../../src/risk/TradePreview.sol";
import {FloorLifecycle} from "../../../src/risk/FloorLifecycle.sol";
import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Side, Stage, RejectCode, AccountingState} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract SweepProbe is LiqEngine {
    function sweep(uint256 n) external returns (FloorStatus s) {
        s = this.floorSweep(n);
        _mockEndAction();
    }

    function reservationOf(uint32 t) external view returns (OA.OrderSums memory) {
        return _resSums(t);
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
        _mockEndAction();
    }
}

/// Lifecycle boundaries with real B controllers and the scripted A port (B033). Each scenario is
/// separate: no keeper, empty book, stale mark, tiny caller budget, frozen registry, halt.
abstract contract LifecycleBoundaryCases is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    SweepProbe e;
    FormulaCoverage cov;

    function setUp() public {
        vm.warp(L0);
        e = new SweepProbe();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        cov = new FormulaCoverage(100_000 * USDC, 2_000 * USDC);
        e.mockSetCoverageScript(cov);
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // leveraged long, E = 60 < MM
        e.mockSetAccount(2, int256(700 * USDC), -1_000_000); // leveraged short, healthy at 0.60
        e.mockSetAccount(3, int256(500 * USDC), 0); // cash only
    }

    function fresh(uint64 to) internal {
        vm.warp(to);
        e.feed(to - 990, to, 6e17, 59e16, 61e16);
    }

    function ioc(uint32 t, Side s, uint16 limit, uint64 lots)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(t, s, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, false, 8);
    }

    /// No keeper ever calls: time alone changes the allowed actions, never a balance.
    function test_noKeeperTimeChangesGatesNotBalances() public {
        int256 c1 = e.mockAccount(1).cashQ;
        int256 x1 = e.mockAccount(1).lots;
        fresh(T - 45_000);
        assertEq(uint8(e.currentStage()), uint8(Stage.BACKING_GRACE));
        TradePreview.OrderPreview memory p = e.previewOrder(3, Side.BUY, 600, 2_000_000, false);
        assertTrue(p.fullBackingRequired, "exact backing applies with no transition transaction");
        fresh(T - 43_200);
        assertEq(uint8(e.currentStage()), uint8(Stage.BACKING_FLOOR));
        RiskView.MarketRiskView memory m = e.marketRiskView();
        assertEq(m.pendingWork & e.PENDING_FLOOR_SWEEP(), e.PENDING_FLOOR_SWEEP());
        assertFalse(e.floorReconciled(), "never reported reconciled by the clock");
        vm.warp(T);
        assertEq(uint8(e.currentStage()), uint8(Stage.HALTED));
        assertEq(e.mockAccount(1).cashQ, c1, "no clock-driven cash change");
        assertEq(e.mockAccount(1).lots, x1);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1000, 8, 0);
        assertEq(uint8(r.reason), uint8(RejectCode.HALTED), "no liquidation after the halt");
    }

    /// Empty book: positive equity stays covered by the reserve; no confiscation.
    function test_emptyBookPositiveEquityStaysCovered() public {
        for (uint256 i; i < 3; ++i) {
            RiskLiquidation.LiquidationResult memory r = e.liq(1, 1_000_000, 64, 0);
            assertEq(uint8(r.result), uint8(LM.Result.NEEDS_MORE_WORK));
        }
        assertEq(e.mockAccount(1).lots, 1_000_000);
        assertEq(e.mockReserveLots(), 0, "no takeover from lack of liquidity");
        assertTrue(
            cov.coverage(1, e.mockAccount(1).cashQ, e.mockAccount(1).lots, e.reservationOf(1)).marketOk
        );
    }

    /// Stale mark: a below-MM reading at an old price is not evidence.
    function test_staleMarkNoMarkLiquidation() public {
        vm.warp(L0 + 12 hours + 400);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1_000_000, 8, 0);
        assertEq(uint8(r.result), uint8(LM.Result.NOT_ELIGIBLE));
        assertEq(e.mockAccount(1).lots, 1_000_000);
        // at the floor the price-free endpoint rule applies even with a stale mark
        vm.warp(T - 43_200);
        e.sweep(32);
        assertEq(e.mockAccount(1).lots, 0, "floor takeover: NO endpoint negative");
        assertEq(e.mockAccount(2).lots, 0, "floor takeover: YES endpoint negative");
        assertEq(e.mockAccount(3).cashQ, int256(500 * USDC), "healthy cash holder untouched");
    }

    /// Tiny caller budget: each call closes at most its budget; never a takeover; fee only on
    /// executed lots.
    function test_tinyBudgetNeverConfiscates() public {
        e.mockSetAccount(9, int256(100_000 * USDC), 0);
        e.rest(9, Side.BUY, 600, 2_000_000);
        for (uint256 i; i < 5; ++i) {
            RiskLiquidation.LiquidationResult memory r = e.liq(1, 1, 1, 0);
            assertEq(uint8(r.result), uint8(LM.Result.NEEDS_MORE_WORK));
            assertEq(r.bookLots, 1);
        }
        assertEq(e.mockAccount(1).lots, 1_000_000 - 5);
        assertEq(e.mockReserveLots(), 0);
        assertEq(e.mockKeeperFeesQ(), 5 * Q, "one atom per executed lot, nothing for no-effect");
    }

    /// The floor sweep freezes the registry: live calls and new joins cannot mutate it.
    function test_registryFrozenDuringSweep() public {
        fresh(T - 43_200);
        e.sweep(1);
        (,, uint64 count,,) = e.floorProgress();
        e.mockSetAccount(7, int256(50 * USDC), 0); // a would-be new participant
        (,, uint64 count2,,) = e.floorProgress();
        assertEq(count2, count, "frozen count");
        MockBookAdapter.PlaceResult memory res = e.place(ioc(7, Side.BUY, 600, 10));
        assertEq(uint8(res.rejection), uint8(RejectCode.BAD_STAGE));
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1000, 8, 0);
        assertEq(uint8(r.reason), uint8(RejectCode.BAD_STAGE), "no ordinary liquidation inside the sweep");
        e.sweep(32);
        assertTrue(e.floorReconciled());
    }

    /// Rollover sweep: matching and releases pause; resumed only after the sweep completes.
    function test_rolloverPausesTrading() public {
        e.mockSetState(AccountingState.ROLLOVER_SWEEP);
        MockBookAdapter.PlaceResult memory res = e.place(ioc(3, Side.BUY, 600, 10));
        assertEq(uint8(res.rejection), uint8(RejectCode.BAD_STAGE));
        (bool ok,) = e.previewRelease(3, 1);
        assertFalse(ok);
        e.mockSetState(AccountingState.READY);
        fresh(L0 + 12 hours + 3600);
        e.openEpoch();
        (ok,) = e.previewRelease(3, 1);
        assertTrue(ok);
    }

    /// Halt during an unfinished floor sweep abandons compression; deficits remain reserve-backed.
    function test_haltAbandonsSweep() public {
        fresh(T - 43_200);
        e.sweep(1);
        vm.warp(T);
        assertEq(uint8(e.sweep(1)), uint8(FloorLifecycle.FloorStatus.ABANDONED_BY_HALT));
        assertFalse(e.floorReconciled());
    }
}
