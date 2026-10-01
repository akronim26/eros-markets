// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {FloorLifecycle} from "../../../src/risk/FloorLifecycle.sol";
import {TradePreview} from "../../../src/risk/TradePreview.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {RejectCode, AccountingState} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract FloorEngine is FloorLifecycle, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function feed(uint64 from, uint64 to, uint256 idx, uint256 bid, uint256 ask) external {
        for (uint64 t = from; t <= to; t += 10) {
            _onIndexObservation(t, idx, true);
            if (ask != 0) _recordPerp(t, bid, ask, 1e6, 1e6);
        }
    }

    function openEpoch() external {
        _riskEpochOpenedWithGuards();
    }

    function sweep(uint256 n) external returns (FloorStatus s) {
        s = this.floorSweep(n);
        _mockEndAction();
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
        _mockEndAction();
    }
}

/// B029: floor reconciliation controller (scripted A floor accounting).
contract B029Test is Test {
    uint256 constant USDC = 1e24;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    FloorEngine e;

    function setUp() public {
        vm.warp(L0);
        e = new FloorEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
        e.mockSetAccount(1, int256(600 * USDC), 0); // flat cash holder
        e.mockSetAccount(2, -int256(480 * USDC), 1_000_000); // leveraged long: NO deficit 480
        e.mockSetAccount(3, int256(700 * USDC), -1_000_000); // leveraged short: YES deficit 300
        e.mockSetAccount(4, 0, 0); // zero-position participant stays registered
        e.mockSetAccount(5, 0, 1_000_000); // exactly backed long: E0 = 0, E1 = 1,000 USDC
    }

    function floorTime() internal {
        vm.warp(T - 43_200);
        e.feed(T - 43_200 - 990, T - 43_200, 6e17, 59e16, 61e16);
    }

    function test_beforeFloorReverts() public {
        vm.expectRevert(FloorLifecycle.FloorNotActive.selector);
        e.sweep(8);
    }

    function test_reconciledOnlyAfterCompleteList() public {
        floorTime();
        assertEq(uint8(e.sweep(2)), uint8(FloorLifecycle.FloorStatus.SWEEPING));
        assertFalse(e.floorReconciled(), "no clock shortcut: 2 of 5 visited");
        assertEq(uint8(e.sweep(2)), uint8(FloorLifecycle.FloorStatus.SWEEPING));
        assertEq(uint8(e.sweep(2)), uint8(FloorLifecycle.FloorStatus.RECONCILED));
        (, uint64 cursor, uint64 count,, uint64 takeovers) = e.floorProgress();
        assertEq(cursor, 5);
        assertEq(count, 5);
        assertEq(takeovers, 2, "only the two deficient accounts");
        assertEq(e.mockAccount(2).lots, 0);
        assertEq(e.mockAccount(3).lots, 0);
        assertEq(e.mockAccount(5).lots, 1_000_000, "exactly backed account untouched");
        assertEq(e.mockReserveLots(), 0, "reserve took the long and the short");
        assertEq(e.mockReserveCashQ(), -int256(480 * USDC) + int256(700 * USDC));
    }

    function test_liveBookCallsCannotMutateSweep() public {
        floorTime();
        e.sweep(1);
        assertEq(e.mockAccount(1).lots, 0);
        IBookRiskHooks.OrderRequest memory r =
            IBookRiskHooks.OrderRequest(1, MathTypes.Side.BUY, IBookRiskHooks.OrderKind.IOC, 600, 10, 0, false, 8);
        MockBookAdapter.PlaceResult memory res = e.place(r);
        assertEq(uint8(res.rejection), uint8(RejectCode.BAD_STAGE));
    }

    function test_noNewExposureIncreasesDeficits() public {
        floorTime();
        e.sweep(32);
        assertTrue(e.floorReconciled());
        // trading reopens only under exact backing: the flat 600 USDC holder may buy at most
        // what it can fully back, never a leveraged size
        TradePreview.OrderPreview memory p = e.previewOrder(1, MathTypes.Side.BUY, 600, 2_000_000, false);
        assertEq(p.d0AfterQ, 0);
        assertEq(p.d1AfterQ, 0);
        assertLe(uint256(p.acceptedCapLots) * 600 * 1e18, 600 * USDC);
    }

    function test_haltOverridesUnfinishedCompression() public {
        floorTime();
        e.sweep(1);
        vm.warp(T);
        assertEq(uint8(e.sweep(1)), uint8(FloorLifecycle.FloorStatus.ABANDONED_BY_HALT));
        assertFalse(e.floorReconciled());
        (, uint64 cursor,,,) = e.floorProgress();
        assertEq(cursor, 1, "no further compression after halt");
    }

    function test_badBudget() public {
        floorTime();
        vm.expectRevert(FloorLifecycle.BadWorkBudget.selector);
        e.sweep(0);
        vm.expectRevert(FloorLifecycle.BadWorkBudget.selector);
        e.sweep(33);
    }
}
