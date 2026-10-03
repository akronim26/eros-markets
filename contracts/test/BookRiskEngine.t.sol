// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../src/Book.sol";
import {IBookRiskHooks} from "../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../src/math/MarginMath.sol";
import {LiquidationMath as LM} from "../src/math/LiquidationMath.sol";
import {OrderAdmissionMath as OA} from "../src/math/OrderAdmissionMath.sol";
import {RiskView} from "../src/risk/RiskView.sol";
import {RiskLiquidation} from "../src/risk/RiskLiquidation.sol";
import {MockAccountingPort} from "./mocks/B/MockAccountingPort.sol";
import {FormulaCoverage} from "./harness/B/RiskHarness.sol";
import {ListingFixture} from "./risk/B/B019.t.sol";
import {RiskFixture} from "./math/B/B011.t.sol";

/// @notice The real risk engine (every risk module up to RiskView) on the real book. The risk
///         lane's mock book is gone; Person A's accounting is still the risk lane's scripted
///         double. Trader ids come from the accounting side (`bind`), as in production.
contract RiskBookEngine is RiskView, Book, MockAccountingPort {
    mapping(address account => uint32) public idOf;
    uint16 public feeTick;
    uint256 public takerFeeAtTickQ;

    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p, uint8 maxFills_) external {
        _initMarket(l, p);
        _initBook(maxFills_);
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

    function bind(address account, uint32 trader) external {
        idOf[account] = trader;
    }

    /// Test fee schedule (A FeeMath stand-in): a taker fee only on fills at `feeTick`.
    function setTakerFeeAt(uint16 tick, uint256 feeQ) external {
        (feeTick, takerFeeAtTickQ) = (tick, feeQ);
    }

    function sums(uint32 t) external view returns (OA.OrderSums memory) {
        return _resSums(t);
    }

    function _traderOf(address account) internal view override returns (uint32 id) {
        id = idOf[account];
        require(id != 0, "unregistered account");
    }

    function _tradeFeeQ(uint64, uint16 tick, bool isMaker) internal view override returns (uint256) {
        return !isMaker && tick == feeTick ? takerFeeAtTickQ : 0;
    }

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        return _placeForced(req);
    }
}

/// Spec §7.8 rows, the worked 5x entry, both audit findings and a liquidation book close, all on
/// the real book. Every result uses the scripted Person A port: none is a real A integration.
contract BookRiskEngineTest is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    RiskBookEngine e;
    FormulaCoverage cov;
    address[10] who; // who[t] signs for trader t

    function setUp() public {
        vm.warp(L0);
        e = new RiskBookEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        e.init(l, RiskFixture.profile(5, true), 64);
        cov = new FormulaCoverage(100_000 * USDC, 2_000 * USDC);
        e.mockSetCoverageScript(cov);
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16); // mark 0.60
        e.openEpoch();
        for (uint32 t = 1; t < 10; ++t) {
            who[t] = makeAddr(string.concat("trader", vm.toString(t)));
            e.bind(who[t], t);
            e.mockSetAccount(t, int256(400 * USDC), 0);
        }
        e.mockSetAccount(1, int256(120 * USDC), 0);
    }

    function _place(uint32 t, IBookRiskHooks.OrderKind kind, bool isBuy, uint16 tick, uint64 lots, bool ro)
        internal
        returns (uint32)
    {
        vm.prank(who[t]);
        return e.placeOrder(Book.Place(kind, isBuy, ro, tick, lots, 8, 0));
    }

    function _post(uint32 t, bool isBuy, uint16 tick, uint64 lots) internal returns (uint32) {
        return _place(t, IBookRiskHooks.OrderKind.POST_ONLY, isBuy, tick, lots, false);
    }

    function _ioc(uint32 t, bool isBuy, uint16 tick, uint64 lots) internal {
        _place(t, IBookRiskHooks.OrderKind.IOC, isBuy, tick, lots, false);
    }

    function _cancel(uint32 t, uint32 id) internal {
        vm.prank(who[t]);
        e.cancel(id);
    }

    /// The worked direct 5x fixture end to end: admission, maker readmission, paired fill, book
    /// debit and permit release.
    function test_DirectFiveXThroughTheBook() public {
        _post(2, false, 600, 1_000_000);
        _ioc(1, true, 600, 1_000_000);
        assertEq(e.mockAccount(1).lots, 1_000_000, "admitted and filled, not stopped");
        assertEq(e.mockAccount(1).cashQ, -int256(480 * USDC));
        assertEq(e.mockAccount(2).cashQ, int256(1000 * USDC));
        assertEq(e.sums(2).askLots, 0, "maker reservation consumed once");
        (uint128 bl,,,,,,) = e.mockContribution(1);
        assertEq(bl, 0, "taker permit released");
        (, uint16 ask) = e.bestBidAsk();
        assertEq(ask, 0);
    }

    /// Row 3: a cancel releases exactly lots x tick, not an average.
    function test_CancelReleasesTheExactTickValue() public {
        uint32 a = _post(2, true, 400, 7);
        _post(2, true, 600, 11);
        _cancel(2, a);
        assertEq(e.sums(2).bidLots, 11);
        assertEq(e.sums(2).bidValueQ, 6600 * Q);
    }

    /// Row 4: after cancel-all and a new rest, the old orders go (by their owner, or pruned when a
    /// taker reaches them) without ever touching the new reservation.
    function test_CancelAllThenOldOrdersGo() public {
        uint32 a = _post(2, false, 600, 5);
        uint32 b = _post(2, false, 610, 5);
        vm.prank(who[2]);
        e.cancelAll();
        _post(2, false, 620, 3);
        _cancel(2, a);
        assertEq(e.sums(2).askLots, 3);
        assertEq(e.sums(2).askValueQ, 1860 * Q);
        _ioc(1, true, 620, 10);
        assertEq(e.getOrder(b).size, 0, "pruned when reached");
        assertEq(e.mockAccount(1).lots, 3, "only the new order filled");
        assertEq(e.sums(2).askLots, 0);
    }

    /// Row 20: a fill the taker cannot take stops it; the first fill persists and the valid
    /// second maker keeps its place.
    function test_ExpectedStopKeepsTheSecondMaker() public {
        cov.set(100_000 * USDC, 7 * USDC, 0, 0);
        e.setTakerFeeAt(500, 1 * USDC);
        e.mockSetAccount(1, int256(3 * USDC), 0);
        uint32 s2 = _post(2, false, 499, 10_000);
        uint32 s3 = _post(3, false, 500, 10_000);
        _ioc(1, true, 500, 20_000); // permit 20,000 lots at 500: NO deficit 10 - 3 = 7 USDC = cap
        assertEq(e.mockAccount(1).lots, 10_000, "first fill persists");
        assertEq(e.getOrder(s2).size, 0);
        assertEq(e.getOrder(s3).size, 10_000, "valid second maker retained");
        assertEq(e.sums(3).askLots, 10_000);
        (uint128 bl,,,,,,) = e.mockContribution(1);
        assertEq(bl, 0, "permit released");
        assertEq(e.mockAccount(1).cashQ, int256(3 * USDC) - int256(10_000 * 499 * Q));
    }

    /// Audit F-02: a reduce-only sale that would turn E +50 into -9.9 USDC is stopped.
    function test_ReduceOnlySaleIntoNegativeEquityStops() public {
        e.mockSetAccount(1, -int256(550 * USDC), 1_000_000);
        uint32 bid = _post(2, true, 1, 100_000);
        _place(1, IBookRiskHooks.OrderKind.IOC, false, 1, 100_000, true);
        assertEq(e.mockAccount(1).lots, 1_000_000);
        assertEq(e.getOrder(bid).size, 100_000, "maker kept");
    }

    /// Liquidation's book close is a forced reduce-only IOC through the ordinary traversal.
    function test_LiquidationClosesThroughTheBook() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000); // E 60 < MM
        e.mockSetAccount(9, int256(100_000 * USDC), 0);
        uint32 bid = _post(9, true, 600, 2_000_000);
        RiskLiquidation.LiquidationResult memory r = e.liquidate(1, 1_000_000, 8, 0);
        assertGt(r.bookLots, 0);
        assertEq(uint8(r.result), uint8(LM.Result.DONE));
        assertEq(e.mockAccount(1).lots, int256(1_000_000) - int256(uint256(r.bookLots)));
        assertEq(e.mockAccount(9).lots, int256(uint256(r.bookLots)));
        assertEq(e.getOrder(bid).size, 2_000_000 - r.bookLots, "filled at the maker's bid");
    }

    /// Audit F-01: a pair that restores health leaves the bid in the book alone.
    function test_PairRestoringHealthLeavesTheBookAlone() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        e.mockSetAccount(2, int256(395 * USDC), -600_000);
        e.mockSetAccount(9, int256(1812 * USDC / 10), 0);
        uint32 bid = _post(9, true, 453, 400_000);
        RiskLiquidation.LiquidationResult memory r = e.liquidate(1, 1_000_000, 8, 2);
        assertEq(r.pairedLots, 600_000);
        assertEq(r.bookLots, 0);
        assertEq(e.getOrder(bid).size, 400_000);
    }
}
