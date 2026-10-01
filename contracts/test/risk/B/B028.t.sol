// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RiskLifecycle} from "../../../src/risk/RiskLifecycle.sol";
import {TradePreview} from "../../../src/risk/TradePreview.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Stage, RejectCode} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract StageEngine is RiskLifecycle, MockBookAdapter, MockAccountingPort {
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

    function touchAccount(uint32 t) external {
        _riskBeginAction();
        _touch(t);
        _mockEndAction();
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
        _mockEndAction();
    }

    function rest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
        _mockEndAction();
    }

    function graceExpiredNow(uint32 t, bool belowMm) external view returns (bool) {
        return _graceExpired(t, _pricingContext(), belowMm);
    }
}

/// B028: derived stage and grace state.
contract B028Test is Test {
    uint256 constant USDC = 1e24;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    StageEngine e;

    function setUp() public {
        vm.warp(L0);
        e = new StageEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
    }

    function keepFresh(uint64 to) internal {
        vm.warp(to);
        e.feed(to - 990, to, 6e17, 59e16, 61e16);
    }

    function test_belowMmHasNoGrace() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // E = 60 < MM ~63.9
        e.touchAccount(1);
        assertTrue(e.graceExpiredNow(1, true));
    }

    function test_graceNonrenewable() public {
        e.mockSetAccount(1, -int256(500 * USDC), 1_000_000); // E = 100: between MM and IM (120)
        e.touchAccount(1);
        LifecycleMath.GraceState memory g = e.graceState(1);
        assertTrue(g.active);
        uint64 anchor = g.anchor;
        assertFalse(e.graceExpiredNow(1, false));
        // later actions and a new risk epoch do not move the anchor
        keepFresh(L0 + 12 hours + 1200);
        e.openEpoch();
        e.touchAccount(1);
        e.touchAccount(1);
        assertEq(e.graceState(1).anchor, anchor, "repeated touch cannot reset grace");
        keepFresh(anchor + 3600);
        assertTrue(e.graceExpiredNow(1, false));
    }

    function test_recoveryClearsGrace() public {
        e.mockSetAccount(1, -int256(500 * USDC), 1_000_000);
        e.touchAccount(1);
        assertTrue(e.graceState(1).active);
        e.mockSetAccount(1, -int256(400 * USDC), 1_000_000); // top-up: E = 200 >= IM
        e.touchAccount(1);
        assertFalse(e.graceState(1).active);
    }

    function test_stageAppliesWithoutKeeper() public {
        e.mockSetAccount(2, int256(120 * USDC), 0);
        keepFresh(T - 45_000); // BACKING_GRACE by time alone
        assertEq(uint8(e.currentStage()), uint8(Stage.BACKING_GRACE));
        TradePreview.OrderPreview memory p = e.previewOrder(2, MathTypes.Side.BUY, 600, 1_000_000, false);
        assertEq(p.acceptedCapLots, 125_000, "halving stops at the first exactly backed size (<= 200,000)");
        assertTrue(p.fullBackingRequired);
    }

    function test_floorInvalidatesOrdersOnFirstAction() public {
        e.mockSetAccount(2, int256(100 * USDC), 0);
        e.mockSetAccount(3, int256(1000 * USDC), 0);
        uint32 slot = e.rest(2, MathTypes.Side.SELL, 600, 1_000_000); // leveraged short commitment
        keepFresh(T - 43_200); // floor
        IBookRiskHooks.OrderRequest memory r =
            IBookRiskHooks.OrderRequest(3, MathTypes.Side.BUY, IBookRiskHooks.OrderKind.IOC, 600, 1000, 0, false, 8);
        MockBookAdapter.PlaceResult memory res = e.place(r);
        assertEq(res.filledLots, 0, "old epoch order cannot execute at the floor");
        (, bool live) = e.mockOrder(slot);
        assertFalse(live);
    }

    function test_bootstrapCannotOverrideHalt() public {
        vm.warp(T);
        RiskContext memory c = e.riskContext();
        assertTrue(c.halted);
        assertEq(uint8(c.stage), uint8(Stage.HALTED));
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.NONE));
        e.mockSetAccount(2, int256(100 * USDC), 0);
        TradePreview.OrderPreview memory p = e.previewOrder(2, MathTypes.Side.BUY, 600, 10, false);
        assertEq(uint8(p.rejection), uint8(RejectCode.HALTED));
    }

    function test_haltStrongerThanMonitor() public {
        vm.prank(address(0x30));
        e.requestReduceOnly("x");
        assertEq(uint8(e.currentStage()), uint8(Stage.REDUCE_ONLY));
        vm.warp(T);
        assertEq(uint8(e.currentStage()), uint8(Stage.HALTED));
    }
}
