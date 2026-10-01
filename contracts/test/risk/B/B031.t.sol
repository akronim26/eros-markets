// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LiquidationBookAdapter} from "../../../src/risk/LiquidationBookAdapter.sol";
import {BookRiskAdapter} from "../../../src/risk/BookRiskAdapter.sol";
import {LiquidationMath as LM} from "../../../src/math/LiquidationMath.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Side, AdmissionMode} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract CloseEngine is LiquidationBookAdapter, MockBookAdapter, MockAccountingPort {
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

    function _liqSubmitIoc(OrderRequest memory req)
        internal
        override
        returns (uint64 filled, uint256 examined)
    {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function rest(uint32 owner, Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
        _mockEndAction();
    }

    function close(uint32 t, uint64 maxLots, uint16 maxExam) external returns (CloseOutcome memory o) {
        _riskBeginAction();
        _touch(t);
        require(_eligibility(t, _actionCtx).mode == LM.Mode.REDUCE, "not REDUCE");
        _resCancelAll(t);
        o = _bookClose(t, maxLots, maxExam, _actionCtx, msg.sender);
        _mockEndAction();
    }

    function forcedAsUser(IBookRiskHooks.OrderRequest memory r) external {
        _mockPlaceWithMode(r, AdmissionMode.FORCED_REDUCTION);
    }

    function sums(uint32 t) external view returns (uint128 bid, uint128 ask) {
        return (_resSums(t).bidLots, _resSums(t).askLots);
    }

    function healthOf(uint32 t) external view returns (MarginMath.Health memory h) {
        (, h) = _health(t, _riskContext());
    }
}

/// B031: bounded book close and continuation (mock book, scripted A port).
contract B031Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    CloseEngine e;

    function build(uint64 liqCap) internal {
        vm.warp(L0);
        e = new CloseEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        l.maxLiqLotsPerBlock = liqCap;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // E = 60 < MM ~63.93
        e.mockSetAccount(2, int256(10_000 * USDC), 0); // bid liquidity provider
        e.mockSetAccount(3, int256(10_000 * USDC), 0);
    }

    function test_closeRestoresHealthRecomputed() public {
        build(10_000_000);
        e.rest(2, Side.BUY, 600, 2_000_000);
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 2_000_000, 8);
        assertEq(uint8(o.result), uint8(LM.Result.DONE));
        assertGe(o.closedLots, 522_929);
        assertLe(o.closedLots, 522_930);
        assertEq(uint8(e.healthOf(1).status), uint8(MarginMath.Status.HEALTHY), "actual post-fill health");
        assertGt(e.mockAccount(1).lots, 0, "partial close, no flip");
        assertEq(e.mockKeeperFeesQ(), uint256(o.closedLots) * Q, "one atom per lot fee to the keeper path");
    }

    function test_smallBudgetNeedsMoreWorkKeepsCover() public {
        build(10_000_000);
        e.rest(2, Side.BUY, 600, 2_000_000);
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 1, 8);
        assertEq(uint8(o.result), uint8(LM.Result.NEEDS_MORE_WORK));
        assertEq(o.closedLots, 1);
        assertEq(e.mockReserveLots(), 0, "no takeover");
        assertEq(e.mockAccount(1).lots, 999_999);
    }

    function test_emptyBookNeedsMoreWork() public {
        build(10_000_000);
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 2_000_000, 8);
        assertEq(uint8(o.result), uint8(LM.Result.NEEDS_MORE_WORK));
        assertEq(o.closedLots, 0);
        (, uint128 ask) = e.sums(1);
        assertEq(ask, 0, "IOC never rests; permit released");
    }

    function test_bidsBelowWorstTickNotHit() public {
        build(10_000_000);
        e.rest(2, Side.BUY, 100, 2_000_000);
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 2_000_000, 8);
        assertGt(o.worstTick, 100);
        assertEq(o.closedLots, 0);
        assertEq(uint8(o.result), uint8(LM.Result.NEEDS_MORE_WORK));
    }

    function test_blockPacing() public {
        build(50_000); // small cap: the account stays below MM between calls
        e.rest(2, Side.BUY, 600, 2_000_000);
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 2_000_000, 8);
        assertEq(o.closedLots, 50_000, "capped by the per-block budget");
        assertEq(uint8(o.result), uint8(LM.Result.NEEDS_MORE_WORK));
        o = e.close(1, 2_000_000, 8);
        assertEq(o.closedLots, 0, "same block: budget exhausted");
        vm.roll(block.number + 1);
        o = e.close(1, 2_000_000, 8);
        assertGt(o.closedLots, 0, "next block: budget refreshed");
    }

    function test_missingCapDisables() public {
        build(0);
        e.rest(2, Side.BUY, 600, 2_000_000);
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 2_000_000, 8);
        assertEq(uint8(o.result), uint8(LM.Result.DISABLED));
        assertEq(e.mockAccount(1).lots, 1_000_000);
    }

    function test_examinationBound() public {
        build(10_000_000);
        for (uint32 i; i < 5; ++i) {
            e.rest(3, Side.BUY, 600, 1);
        }
        LiquidationBookAdapter.CloseOutcome memory o = e.close(1, 2_000_000, 3);
        assertEq(o.examined, 3);
        assertEq(o.closedLots, 3);
    }

    function test_forcedModeNotUserSelectable() public {
        build(10_000_000);
        IBookRiskHooks.OrderRequest memory r =
            IBookRiskHooks.OrderRequest(1, Side.SELL, IBookRiskHooks.OrderKind.IOC, 500, 10, 0, true, 8);
        vm.expectRevert(BookRiskAdapter.ForcedReductionNotUserSelectable.selector);
        e.forcedAsUser(r);
    }
}
