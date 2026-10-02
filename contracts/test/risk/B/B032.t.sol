// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RiskView} from "../../../src/risk/RiskView.sol";
import {RiskLiquidation} from "../../../src/risk/RiskLiquidation.sol";
import {FloorLifecycle} from "../../../src/risk/FloorLifecycle.sol";
import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {IAccountingPort} from "../../../provisional/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Side, AdmissionMode, RejectCode, AccountingState} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract LiqEngine is RiskView, MockBookAdapter, MockAccountingPort {
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

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function rest(uint32 owner, Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
        _mockEndAction();
    }

    function liq(uint32 t, uint64 maxLots, uint16 maxExam, uint32 partner)
        external
        returns (LiquidationResult memory r)
    {
        r = this.liquidate(t, maxLots, maxExam, partner);
        _mockEndAction();
    }

    function touchOnly(uint32 t) external {
        _riskBeginAction();
        _touch(t);
        _mockEndAction();
    }

    function bidLots(uint32 t) external view returns (uint128) {
        return _resSums(t).bidLots;
    }
}

/// B032: liquidation lifecycle and views (mock book, scripted A port).
contract B032Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    LiqEngine e;

    function setUp() public {
        vm.warp(L0);
        e = new LiqEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
        e.mockSetAccount(9, int256(100_000 * USDC), 0); // liquidity provider
    }

    function test_noEffectCallKeepsOrdersNoReward() public {
        e.mockSetAccount(1, int256(1000 * USDC), 0);
        e.rest(1, Side.BUY, 590, 100);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1000, 8, 0);
        assertEq(uint8(r.result), uint8(LM.Result.NOT_ELIGIBLE));
        assertEq(e.bidLots(1), 100);
        assertEq(e.mockKeeperFeesQ(), 0);
    }

    function test_takeoverCarriesPredicateAndCutoff() public {
        e.mockSetAccount(1, -int256(600 * USDC), 1_000_000); // fresh E = 0
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1000, 8, 0);
        assertEq(uint8(r.result), uint8(LM.Result.TAKEOVER_AUTHORIZED));
        (uint32 who, uint8 pred, uint64 cutoff, uint64 rv) = e.mockLastTakeover();
        assertEq(who, 1);
        assertEq(pred, 1);
        assertEq(cutoff, uint64(block.timestamp));
        assertEq(cutoff, r.cutoff);
        assertEq(rv, e.riskContext().riskVersion);
        assertEq(e.mockReserveLots(), 1_000_000);
        assertEq(e.mockKeeperFeesQ(), 0, "takeover pays no fee");
    }

    function test_pairThenBookNeverFlips() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // long, below MM
        e.mockSetAccount(2, int256(660 * USDC), -1_000_000); // short, below MM
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 2_000_000, 8, 2);
        assertEq(r.pairedLots, 1_000_000, "min(requested, |xa|, |xb|)");
        assertEq(r.lotsAfter, 0, "reaches zero, never crosses");
        assertEq(e.mockAccount(2).lots, 0);
        assertEq(uint8(r.result), uint8(LM.Result.DONE));
    }

    function test_partialPairThenBookClose() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        e.mockSetAccount(2, int256(660 * USDC), -1_000_000);
        e.rest(9, Side.BUY, 600, 2_000_000);
        e.mockSetAccount(3, int256(660 * USDC), -1_000_000);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 300_000, 8, 2);
        assertEq(r.pairedLots, 300_000);
        assertEq(r.bookLots, 0, "budget used by the pair");
        assertGt(r.lotsAfter, 0, "partial reduction keeps the side");
        r = e.liq(1, 2_000_000, 8, 0);
        assertGt(r.lotsAfter, 0);
    }

    /// Audit F-01: a pair that restores health ends the call; spare budget never sells the rest.
    function test_pairRestoringHealthSkipsBookClose() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // E 60 < MM: eligible
        e.mockSetAccount(2, int256(395 * USDC), -600_000);
        e.mockSetAccount(9, int256(1812 * USDC / 10), 0);
        e.rest(9, Side.BUY, 453, 400_000);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1_000_000, 8, 2);
        assertEq(r.pairedLots, 600_000);
        assertEq(r.bookLots, 0, "healthy remainder kept");
        assertEq(uint8(r.result), uint8(LM.Result.DONE));
        assertEq(e.mockAccount(1).lots, 400_000);
        // 600 claims at tick 600 less the 0.6 USDC pair fee: E 59.4 >= IM 48
        assertEq(e.mockAccount(1).cashQ, -int256(1806 * USDC / 10));
        assertEq(e.bidLots(9), 400_000, "maker bid untouched");
    }

    function test_tinyBudgetNeedsMoreWork() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        e.rest(9, Side.BUY, 600, 2_000_000);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1, 8, 0);
        assertEq(uint8(r.result), uint8(LM.Result.NEEDS_MORE_WORK));
        assertEq(e.mockReserveLots(), 0);
    }

    function test_haltAndSweepGates() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        e.mockSetState(AccountingState.FLOOR_SWEEP);
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1000, 8, 0);
        assertEq(uint8(r.reason), uint8(RejectCode.BAD_STAGE));
        e.mockSetState(AccountingState.READY);
        vm.warp(T);
        r = e.liq(1, 1000, 8, 0);
        assertEq(uint8(r.reason), uint8(RejectCode.HALTED));
        assertEq(e.mockAccount(1).lots, 1_000_000);
    }

    function test_zeroBudgetRejected() public {
        vm.expectRevert(FloorLifecycle.BadWorkBudget.selector);
        e.liq(1, 0, 8, 0);
        vm.expectRevert(FloorLifecycle.BadWorkBudget.selector);
        e.liq(1, 10, 0, 0);
    }

    function test_viewsLabelState() public {
        e.mockSetAccount(1, -int256(500 * USDC), 1_000_000); // between MM and IM
        e.touchOnly(1);
        RiskView.AccountRiskView memory a = e.accountRiskView(1);
        assertTrue(a.markAvailable);
        assertEq(uint8(a.status), uint8(MarginMath.Status.BELOW_IM));
        assertTrue(a.graceActive);
        assertGt(a.graceEndsAt, a.asOfTime);
        assertEq(uint8(a.liquidationMode), uint8(LM.Mode.NONE), "inside grace");
        vm.warp(L0 + 12 hours + 400);
        a = e.accountRiskView(1);
        assertFalse(a.markAvailable, "stale mark flagged, not priced at 0");
        RiskView.MarketRiskView memory m = e.marketRiskView();
        assertFalse(m.markAvailable);
        assertEq(m.liquidationCapLots, 10_000_000);
        vm.warp(T - 43_200);
        m = e.marketRiskView();
        assertEq(m.pendingWork & e.PENDING_FLOOR_SWEEP(), e.PENDING_FLOOR_SWEEP(), "floor sweep pending");
    }
}
