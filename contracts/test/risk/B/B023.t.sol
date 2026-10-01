// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {OrderAdmission} from "../../../src/risk/OrderAdmission.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {IAccountingPort} from "../../../provisional/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {AdmissionMode, RejectCode} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract AdmHarness is OrderAdmission, MockAccountingPort {
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

    function ctx() public view returns (RiskContext memory) {
        return _riskContext();
    }

    function rest(uint32 owner, bool isBid, uint16 tick, uint64 lots) external {
        _acctBeginAction();
        _acctTouch(owner);
        _resAdd(owner, isBid, tick, lots, 0);
    }

    function taker(TakerInput memory t) external view returns (TakerDecision memory) {
        return _takerDecision(ctx(), t);
    }

    function maker(uint32 owner, bool isBid, uint64 proposed) external view returns (MakerDecision memory) {
        (uint64 m, uint64 a) = _currentTag(owner);
        return _makerDecision(ctx(), MakerInput(owner, isBid, m, a, false, 0, proposed));
    }

    /// Admission -> permit -> maker readmission -> preflight -> A posting -> reservation release.
    function directFill(uint32 tk, uint32 mk, uint16 tick, uint64 lots) external returns (bool) {
        RiskContext memory c = ctx();
        _acctBeginAction();
        _acctTouch(tk);
        TakerDecision memory d = _takerDecision(c, TakerInput(tk, true, tick, lots, false));
        require(d.capLots == lots, "taker cap");
        _permitReserve(tk, true, tick, d.capLots, d.feeCapQ);
        _acctTouch(mk);
        _resSyncEpoch(mk);
        MakerDecision memory md = _makerDecision(
            c, MakerInput(mk, false, _res[mk].marketEpoch, _res[mk].accountEpoch, false, 0, lots)
        );
        require(!md.prune, "maker pruned");
        (bool tOk, bool mOk, bool marketOk) = _preflight(FillPlan(tk, mk, true, tick, lots, 0, 0, tick, 0, 0));
        require(tOk && mOk && marketOk, "preflight");
        _acctPostFill(IAccountingPort.FillDelta(mk, tk, true, lots, tick, 0, 0));
        _resConsumeFill(mk, false, tick, lots, 0);
        _permitConsume(tk, true, tick, lots, 0);
        _permitRelease(tk);
        _mockEndAction();
        return true;
    }
}

/// B023: maker/taker admission decisions (scripted A port; coverage from FormulaCoverage).
contract B023Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    AdmHarness h;
    FormulaCoverage cov;

    function setUp() public {
        vm.warp(L0);
        h = new AdmHarness();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours; // act 12 h after listing: 29 days left
        h.init(l, RiskFixture.profile(5, true));
        cov = new FormulaCoverage(100_000 * USDC, 2_000 * USDC);
        h.mockSetCoverageScript(cov);
        vm.warp(L0 + 12 hours);
        h.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        h.openEpoch();
        h.mockSetAccount(1, int256(120 * USDC), 0); // taker
        h.mockSetAccount(2, int256(400 * USDC), 0); // maker
    }

    function test_contextIsNormalAt29Days() public view {
        RiskContext memory c = h.ctx();
        assertTrue(c.markOk);
        assertEq(c.markWad, 6e17);
        assertEq(c.secsToT, 29 days);
    }

    function test_directFiveXPairedFillThroughMockPort() public {
        h.rest(2, false, 600, 1_000_000);
        assertTrue(h.directFill(1, 2, 600, 1_000_000));
        IAccountingPort.AccountView memory t = h.mockAccount(1);
        IAccountingPort.AccountView memory m = h.mockAccount(2);
        assertEq(t.lots, 1_000_000);
        assertEq(t.cashQ, -int256(480 * USDC));
        assertEq(m.lots, -1_000_000);
        assertEq(m.cashQ, int256(1000 * USDC));
        (uint128 bl,,,,,,) = h.mockContribution(1);
        assertEq(bl, 0, "permit released after the fill");
    }

    function test_directFiveXRejectedWithSmallReserve() public {
        cov.set(479 * USDC, 2_000 * USDC, 0, 0);
        OrderAdmission.TakerDecision memory d =
            h.taker(OrderAdmission.TakerInput(1, true, 600, 1_000_000, false));
        assertLt(d.capLots, 1_000_000, "same margin, reserve cannot cover the NO deficit");
        assertLe(
            uint256(d.capLots) * 600 * Q, 120 * USDC + 479 * USDC, "admitted NO deficit fits the reserve"
        );
    }

    function test_coverageShortageStopsBeforeMutation() public {
        // No reserve: only the part the taker exactly backs itself can be admitted.
        cov.set(0, 2_000 * USDC, 0, 0);
        OrderAdmission.TakerDecision memory d =
            h.taker(OrderAdmission.TakerInput(1, true, 600, 1_000_000, false));
        assertEq(d.capLots, 125_000, "1e6 -> 5e5 -> 2.5e5 fail coverage; 1.25e5 is exactly backed");
        assertLe(uint256(d.capLots) * 600 * Q, 120 * USDC);
        assertEq(h.mockCallCount(), 0, "decision is a view: no accounting mutation");
        cov.set(0, 2_000 * USDC, 0, 1); // any YES shortfall elsewhere: nothing fits
        d = h.taker(OrderAdmission.TakerInput(1, false, 600, 1_000_000, false));
        assertEq(d.capLots, 0);
        assertEq(uint8(d.reason), uint8(RejectCode.MARKET_COVERAGE));
    }

    function test_sideFlipUsesShortEnvelope() public {
        // long 1 claim with 20 USDC; an ask for 3,000 claims would reach short 2,999 claims
        h.mockSetAccount(3, int256(20 * USDC), 1000);
        OrderAdmission.TakerDecision memory d =
            h.taker(OrderAdmission.TakerInput(3, false, 600, 3_000_000, false));
        assertLt(d.capLots, 3_000_000, "full flip rejected by the short-side envelope");
        assertGt(d.capLots, 1000, "but a partial flip within equity is admitted");
        uint256 shortReach = uint256(d.capLots) - 1000;
        MarginMath.Margin memory sm = MarginMath.sideMargin(
            shortReach, false, 6e17, 29 days, L0 + 12 hours, RiskFixture.profile(5, true)
        );
        // Emin = cash + x * mark (asks at the mark add no adverse term) = 20.6 USDC
        assertLe(sm.imQ, 20 * USDC + 1000 * 600 * Q);
    }

    function test_underMarginMakerPrunedWithCancelAll() public {
        h.mockSetAccount(4, int256(10 * USDC), 0);
        h.rest(4, true, 600, 1_000_000); // leveraged bid far beyond its collateral
        OrderAdmission.MakerDecision memory d = h.maker(4, true, 1000);
        assertTrue(d.prune);
        assertTrue(d.cancelAll);
        assertEq(uint8(d.reason), uint8(RejectCode.MAKER_BELOW_IM));
    }

    function test_healthyMakerAdmitted() public {
        h.rest(2, false, 600, 1_000_000);
        OrderAdmission.MakerDecision memory d = h.maker(2, false, 1_000_000);
        assertFalse(d.prune);
        assertEq(d.allowedLots, 1_000_000);
    }

    function test_reduceOnlyStageAndMode() public {
        vm.prank(address(0x30));
        h.requestReduceOnly("news");
        OrderAdmission.TakerDecision memory d = h.taker(OrderAdmission.TakerInput(1, true, 600, 10, false));
        assertEq(uint8(d.reason), uint8(RejectCode.BAD_STAGE));
        h.mockSetAccount(5, 0, 10);
        d = h.taker(OrderAdmission.TakerInput(5, false, 600, 25, true));
        assertEq(d.capLots, 10, "reduce-only clipped to the position");
        assertEq(uint8(d.mode), uint8(AdmissionMode.VOLUNTARY_REDUCTION));
        d = h.taker(OrderAdmission.TakerInput(5, true, 600, 25, true));
        assertEq(uint8(d.reason), uint8(RejectCode.NO_REDUCIBLE_POSITION));
    }

    function test_sizeAndPriceGates() public view {
        OrderAdmission.TakerDecision memory d = h.taker(OrderAdmission.TakerInput(1, true, 0, 10, false));
        assertEq(uint8(d.reason), uint8(RejectCode.INVALID_PRICE_OR_SIZE));
        d = h.taker(OrderAdmission.TakerInput(1, true, 600, uint64(type(uint32).max) + 1, false));
        assertEq(uint8(d.reason), uint8(RejectCode.INVALID_PRICE_OR_SIZE));
    }
}

/// Bootstrap (no normal mark): only exactly backed orders inside the index band.
contract B023BootstrapTest is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    AdmHarness h;

    function setUp() public {
        vm.warp(1_000_000);
        h = new AdmHarness();
        h.init(
            ListingFixture.make(1_000_000, address(0xAC), address(0x30), address(0x60), address(0x51)),
            RiskFixture.profile(5, true)
        );
        h.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        h.feed(1_000_000 - 400, 1_000_000, 6e17, 0, 0); // index only, empty book
        h.mockSetAccount(1, int256(600 * Q * 1000), 0); // exactly 1,000 lots at tick 600
    }

    function test_exactlyBackedAdmittedLeveragedNot() public view {
        OrderAdmission.TakerDecision memory d = h.taker(OrderAdmission.TakerInput(1, true, 600, 1000, false));
        assertEq(d.capLots, 1000);
        d = h.taker(OrderAdmission.TakerInput(1, true, 600, 2000, false));
        assertEq(d.capLots, 1000, "halved to the exactly backed size");
    }

    function test_outsideBand() public view {
        OrderAdmission.TakerDecision memory d = h.taker(OrderAdmission.TakerInput(1, true, 700, 10, false));
        assertEq(uint8(d.reason), uint8(RejectCode.OUTSIDE_BAND));
    }
}
