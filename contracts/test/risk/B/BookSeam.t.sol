// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {OrderLifecycle} from "../../../src/risk/OrderLifecycle.sol";
import {BookRiskAdapter} from "../../../src/risk/BookRiskAdapter.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {MockAccountingPort, ICoverageScript} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {RejectCode, AccountingState} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// Real B hooks (OrderLifecycle on BookRiskAdapter) + mock book + scripted A accounting.
contract SeamEngine is OrderLifecycle, MockBookAdapter, MockAccountingPort {
    uint256 public feeBps; // optional test fee (A FeeMath stand-in for the fragmented-fee row)

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

    function setFeeBps(uint256 b) external {
        feeBps = b;
    }

    uint16 public feeTick;
    uint256 public takerFeeAtTickQ;

    /// Test fee schedule (A FeeMath stand-in): a taker fee only on fills at `feeTick`.
    function setTakerFeeAt(uint16 tick, uint256 feeQ) external {
        (feeTick, takerFeeAtTickQ) = (tick, feeQ);
    }

    function _tradeFeeQ(uint64, uint16 tick, bool isMaker) internal view override returns (uint256) {
        return !isMaker && tick == feeTick ? takerFeeAtTickQ : 0;
    }

    function _feeCapQ(uint64 lots, uint16 tick) internal view override returns (uint256) {
        uint256 n = uint256(lots) * tick * 1e18 * feeBps;
        return n == 0 ? 0 : (n - 1) / 10_000 + 1; // ceiling of the total worst-limit fee, once
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
        _mockEndAction();
    }

    function rest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots, uint32 expiry, bool ro)
        external
        returns (uint32 s)
    {
        s = _mockRest(owner, side, tick, lots, expiry, ro);
        _mockEndAction();
    }

    function cancel(uint32 slot) external returns (bool ok) {
        ok = _mockCancel(slot);
        _mockEndAction();
    }

    function cancelAll(uint32 t) external {
        _cancelAllTopLevel(t);
        _mockEndAction();
    }

    function invalidateMarket() external {
        _invalidateMarketOrders();
    }

    function sums(uint32 t) external view returns (OA.OrderSums memory) {
        return _resSums(t);
    }

    function orderAt(uint32 slot) external view returns (OrderView memory v, bool live) {
        return (_bk[slot - 1].v, _bk[slot - 1].live);
    }
}

/// Market-wide spec §7.3 coverage over every listed account (test-side script): the queried
/// account uses the proposed state; the others use their current state and stored contribution.
contract MarketCoverage is ICoverageScript {
    SeamEngine public e;
    uint256 public reserveQ;
    uint256 public capQ;
    uint32[] public traders;

    constructor(SeamEngine e_, uint256 reserveQ_, uint256 capQ_, uint32[] memory ts) {
        (e, reserveQ, capQ, traders) = (e_, reserveQ_, capQ_, ts);
    }

    function setReserve(uint256 r) external {
        reserveQ = r;
    }

    function _d(int256 cashQ, int256 lots, OA.OrderSums memory s)
        internal
        pure
        returns (uint256 d0, uint256 d1)
    {
        int256 u = 1000e18;
        int256 cEff = cashQ - int256(s.feeCapQ);
        int256 e0 = cEff - int256(s.bidValueQ);
        int256 e1 = cEff + u * lots - u * int256(uint256(s.askLots)) + int256(s.askValueQ);
        d0 = e0 < 0 ? uint256(-e0) : 0;
        d1 = e1 < 0 ? uint256(-e1) : 0;
    }

    function coverage(uint32 trader, int256 cashQ, int256 lots, OA.OrderSums calldata s)
        external
        view
        returns (OA.CoverageInput memory c)
    {
        (c.d0Q, c.d1Q) = _d(cashQ, lots, s);
        uint256 t0 = c.d0Q;
        uint256 t1 = c.d1Q;
        for (uint256 i; i < traders.length; ++i) {
            if (traders[i] == trader) continue;
            MockAccountingPort.AccountView memory a = e.mockAccount(traders[i]);
            OA.OrderSums memory o;
            (o.bidLots, o.bidValueQ, o.askLots, o.askValueQ, o.feeCapQ, o.maxBidTick, o.minAskTick) =
                e.mockContribution(traders[i]);
            (uint256 x0, uint256 x1) = _d(a.cashQ, a.lots, o);
            (t0, t1) = (t0 + x0, t1 + x1);
        }
        c.deficitCapQ = capQ;
        c.marketOk = reserveQ >= t0 && reserveQ >= t1;
    }
}

/// The spec §7.8 mock-integration table, run through real B hooks. Row numbers follow the table.
/// Every result here uses the scripted A port: none of it is real Person A integration.
abstract contract BookSeamCases is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    SeamEngine e;
    FormulaCoverage fcov;

    function build(uint256 cap) internal returns (SeamEngine x) {
        vm.warp(L0);
        x = new SeamEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        l.deploymentCapX = cap;
        x.init(l, RiskFixture.profile(cap, true));
        fcov = new FormulaCoverage(100_000 * USDC, 2_000 * USDC);
        x.mockSetCoverageScript(fcov);
        vm.warp(L0 + 12 hours);
        x.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        x.openEpoch();
        for (uint32 t = 1; t <= 6; ++t) {
            x.mockSetAccount(t, int256(400 * USDC), 0);
        }
    }

    function req(uint32 t, MathTypes.Side s, uint16 limit, uint64 lots, uint16 steps)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(t, s, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, false, steps);
    }

    // Row 1
    function test_row01_exactIntegerBilateralTrade() public {
        e = build(5);
        e.rest(2, MathTypes.Side.SELL, 613, 17, 0, false);
        e.place(req(1, MathTypes.Side.BUY, 613, 17, 8));
        assertEq(e.mockAccount(1).lots, 17);
        assertEq(e.mockAccount(2).lots, -17);
        assertEq(e.mockAccount(1).cashQ, int256(400 * USDC) - 10_421 * int256(Q));
        assertEq(e.mockAccount(2).cashQ, int256(400 * USDC) + 10_421 * int256(Q));
    }

    // Row 2 (at 1x): fully backed long 1 claim, cash 0, rests an ask for 2.3 claims at 0.55.
    function test_row02_bothOutcomeAdmission() public {
        e = build(1);
        e.mockSetAccount(1, 0, 1000);
        vm.expectRevert(
            abi.encodeWithSelector(BookRiskAdapter.RestRejected.selector, RejectCode.TAKER_CAPACITY)
        );
        e.rest(1, MathTypes.Side.SELL, 550, 2300, 0, false);
        OA.OrderSums memory s = OA.addOrder(OA.emptySums(), false, 2300, 550, 0);
        assertEq(fcov.coverage(1, 0, 1000, s).d1Q, 35_000 * Q, "YES value -35,000 atoms");
    }

    // Row 3
    function test_row03_valueReleaseRequiresTick() public {
        e = build(5);
        uint32 a = e.rest(1, MathTypes.Side.BUY, 400, 7, 0, false);
        e.rest(1, MathTypes.Side.BUY, 600, 11, 0, false);
        e.cancel(a);
        assertEq(e.sums(1).bidLots, 11);
        assertEq(e.sums(1).bidValueQ, 6600 * Q);
    }

    // Row 4
    function test_row04_currentEpochCancelAll() public {
        e = build(5);
        e.rest(1, MathTypes.Side.SELL, 600, 5, 0, false);
        e.rest(1, MathTypes.Side.SELL, 610, 5, 0, false);
        e.cancelAll(1);
        e.rest(1, MathTypes.Side.SELL, 620, 3, 0, false);
        e.cancel(1);
        e.cancel(2); // lazy prune of old nodes: no-op on current sums
        assertEq(e.sums(1).askLots, 3);
        assertEq(e.sums(1).askValueQ, 1860 * Q);
    }

    // Row 5
    function test_row05_stageEpochSidecar() public {
        e = build(5);
        e.rest(2, MathTypes.Side.SELL, 600, 5, 0, false);
        e.invalidateMarket(); // stage change: no account visited
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 600, 5, 8));
        assertEq(r.filledLots, 0, "old account epoch alone cannot authorize the fill");
        (, bool live) = e.orderAt(1);
        assertFalse(live);
    }

    // Row 8: maker funding settles on the old position before the fill.
    function test_row08_makerFundingBeforeFill() public {
        e = build(5);
        e.mockSetAccount(2, int256(400 * USDC), -10);
        e.rest(2, MathTypes.Side.SELL, 600, 5, 0, false);
        e.mockSetTouchDebit(2, 7 * int256(Q)); // A: funding owed on the old 10-lot short
        uint256 n0 = e.mockCallCount();
        e.place(req(1, MathTypes.Side.BUY, 600, 5, 8));
        assertEq(e.mockAccount(2).cashQ, int256(400 * USDC) - 7 * int256(Q) + 5 * 600 * int256(Q));
        assertEq(e.mockAccount(2).lots, -15);
        // sequence: the maker TOUCH precedes the POST_FILL
        uint256 touchAt;
        uint256 postAt;
        for (uint256 i = n0; i < e.mockCallCount(); ++i) {
            (MockAccountingPort.CallKind k, uint32 a,,,) = e.mockCalls(i);
            if (k == MockAccountingPort.CallKind.TOUCH && a == 2 && touchAt == 0) touchAt = i;
            if (k == MockAccountingPort.CallKind.POST_FILL) postAt = i;
        }
        assertGt(touchAt, 0);
        assertLt(touchAt, postAt);
    }

    // Row 9: accrued premium makes the maker fail readmission: invalidate, skip, no bad-debt payment.
    function test_row09_makerPremiumBeforeAdmission() public {
        e = build(5);
        e.mockSetAccount(2, int256(100 * USDC), 0);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000, 0, false); // leveraged short commitment within IM
        e.mockSetTouchDebit(2, int256(90 * USDC)); // A: accrued premium credited to reserve
        int256 reserveBefore = e.mockReserveCashQ();
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 600, 10, 8));
        assertEq(r.filledLots, 0);
        assertEq(e.mockReserveCashQ() - reserveBefore, int256(90 * USDC), "only the premium moved");
        assertEq(e.mockAccount(2).lots, 0);
        assertEq(e.sums(2).askLots, 0, "commitments invalidated");
    }

    // Row 10: same market epoch, the mark moves enough to violate maker IM.
    function test_row10_priceOnlyReadmission() public {
        e = build(5);
        e.mockSetAccount(2, int256(100 * USDC), 0);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000, 0, false); // short commitment, IM ~95.9 <= 100 at 0.60
        vm.warp(L0 + 12 hours + 400);
        e.feed(L0 + 12 hours + 10, L0 + 12 hours + 400, 66e16, 65e16, 67e16); // mark -> 0.66
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 600, 10, 8));
        assertEq(r.filledLots, 0, "maker rechecked at the new mark and removed");
        assertEq(e.sums(2).askLots, 0);
    }

    // Row 14
    function test_row14_worstLimitImprovement() public {
        e = build(5);
        e.rest(2, MathTypes.Side.SELL, 610, 3, 0, false);
        e.rest(3, MathTypes.Side.SELL, 620, 3, 0, false);
        e.place(req(1, MathTypes.Side.BUY, 650, 6, 8));
        int256 spent = int256(400 * USDC) - e.mockAccount(1).cashQ;
        assertEq(spent, int256((3 * 610 + 3 * 620) * Q));
        assertLt(uint256(spent), 6 * 650 * Q, "better fills never consume more than the reserved limit");
    }

    // Row 15: a fill that improves NO slack but worsens YES slack beyond the reserve.
    function test_row15_bothReserveOutcomes() public {
        e = build(5);
        e.mockSetAccount(2, int256(100 * USDC), 0);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000, 0, false); // filled: maker YES deficit 300 USDC
        fcov.set(100_000 * USDC, 2_000 * USDC, 0, 100_000 * USDC - 1); // YES slack 1 Q; NO slack ample
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 600, 1_000_000, 8));
        assertEq(r.filledLots, 0, "stopped before mutation");
        assertEq(e.mockAccount(1).lots, 0);
        assertEq(e.mockAccount(2).lots, 0);
        (, bool live) = e.orderAt(1);
        assertTrue(live, "global YES shortfall stops the taker; the maker is kept");
    }

    // Row 16: the second fill reads aggregates updated by the first fill and the maker's touch.
    function test_row16_mutableAggregates() public {
        e = build(5);
        uint32[] memory ts = new uint32[](3);
        (ts[0], ts[1], ts[2]) = (1, 2, 3);
        MarketCoverage mc = new MarketCoverage(e, 1_000 * USDC, 2_000 * USDC, ts);
        e.mockSetCoverageScript(mc);
        e.mockSetAccount(1, int256(1_000 * USDC), 0);
        e.mockSetAccount(2, int256(100 * USDC), 0);
        e.mockSetAccount(3, int256(100 * USDC), 0);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000, 0, false); // YES deficit 300 USDC each if filled
        e.rest(3, MathTypes.Side.SELL, 600, 1_000_000, 0, false);
        e.mockSetTouchDebit(3, int256(500 * USDC)); // maker 3 owes funding settled at its touch
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 600, 2_000_000, 8));
        assertEq(r.filledLots, 1_000_000, "first fill persists; second fails on updated totals");
        assertEq(e.mockAccount(3).lots, 0);
    }

    // Row 17: expired + self + stale + failed readmission with maxSteps 4.
    function test_row17_dirtyMakerQueue() public {
        e = build(5);
        vm.roll(100);
        e.rest(2, MathTypes.Side.SELL, 600, 5, 99, false); // expired
        e.rest(1, MathTypes.Side.SELL, 600, 5, 0, false); // self
        e.rest(3, MathTypes.Side.SELL, 600, 5, 0, false);
        e.cancelAll(3); // stale account epoch, node still linked
        e.mockSetAccount(4, int256(1 * USDC), 0);
        e.rest(4, MathTypes.Side.SELL, 600, 5, 0, false);
        e.mockSetTouchDebit(4, int256(1 * USDC)); // fails readmission at its touch
        e.rest(5, MathTypes.Side.SELL, 600, 5, 0, false); // fifth node: never visited
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 600, 5, 4));
        assertEq(e.lastExamined(), 4);
        assertEq(r.filledLots, 0);
        (, bool live5) = e.orderAt(5);
        assertTrue(live5, "zero fifth-node visit");
    }

    // Row 20: first fill valid; the second would push the taker past its per-account deficit
    // cap (a fee charged only at tick 500), so the taker stops. The first fill persists, the
    // valid second maker remains and the permit is released.
    function test_row20_expectedStop() public {
        e = build(5);
        fcov.set(100_000 * USDC, 7 * USDC, 0, 0);
        e.setTakerFeeAt(500, 1 * USDC);
        e.mockSetAccount(1, int256(3 * USDC), 0); // 3 USDC covers IM (~2.4) for 20 claims
        uint32 s2 = e.rest(2, MathTypes.Side.SELL, 499, 10_000, 0, false);
        uint32 s3 = e.rest(3, MathTypes.Side.SELL, 500, 10_000, 0, false);
        // permit: 20,000 lots at 500 -> NO deficit 10 - 3 = 7 USDC = the cap exactly
        MockBookAdapter.PlaceResult memory r = e.place(req(1, MathTypes.Side.BUY, 500, 20_000, 8));
        assertEq(r.filledLots, 10_000, "first fill persists");
        (, bool live2) = e.orderAt(s2);
        (, bool live3) = e.orderAt(s3);
        assertFalse(live2);
        assertTrue(live3, "valid second maker retained");
        assertEq(e.sums(3).askLots, 10_000);
        (uint128 bl,,,,,,) = e.mockContribution(1);
        assertEq(bl, 0, "permit released");
        assertEq(e.mockAccount(1).cashQ, int256(3 * USDC) - int256(10_000 * 499 * Q));
    }

    // Row 22: fragmented fees stay within the once-reserved ceiling.
    function test_row22_fragmentedFees() public {
        e = build(5);
        e.setFeeBps(7);
        for (uint32 m = 2; m <= 5; ++m) {
            e.rest(m, MathTypes.Side.SELL, 600, 3, 0, false);
        }
        OA.OrderSums memory before = e.sums(1);
        assertEq(before.feeCapQ, 0);
        e.place(req(1, MathTypes.Side.BUY, 600, 12, 8));
        assertEq(e.mockAccount(1).lots, 12);
        assertEq(e.sums(1).feeCapQ, 0, "permit fee cap fully consumed or released, never negative");
    }

    // Row 27
    function test_row27_packedSizeRange() public {
        e = build(5);
        MockBookAdapter.PlaceResult memory r =
            e.place(req(1, MathTypes.Side.BUY, 600, uint64(type(uint32).max) + 1, 8));
        assertEq(uint8(r.rejection), uint8(RejectCode.INVALID_PRICE_OR_SIZE));
    }

    // Row 29: rollover gate.
    function test_row29_rolloverGate() public {
        e = build(5);
        uint32 slot = e.rest(2, MathTypes.Side.SELL, 600, 5, 0, false);
        e.invalidateMarket(); // every rollover invalidates the market order epoch
        e.mockSetState(AccountingState.ROLLOVER_SWEEP);
        assertEq(uint8(e.place(req(1, MathTypes.Side.BUY, 600, 5, 8)).rejection), uint8(RejectCode.BAD_STAGE));
        vm.expectRevert(abi.encodeWithSelector(BookRiskAdapter.RestRejected.selector, RejectCode.BAD_STAGE));
        e.rest(1, MathTypes.Side.BUY, 590, 5, 0, false);
        assertTrue(e.cancel(slot), "stale-order pruning stays available");
        assertEq(e.mockAccount(2).cashQ, int256(400 * USDC), "no cash mutation inside the sweep");
    }

    // Row 34: same-block accrual: each account touched once per action.
    function test_row34_sameBlockSingleTouch() public {
        e = build(5);
        e.rest(2, MathTypes.Side.SELL, 600, 1, 0, false);
        e.rest(2, MathTypes.Side.SELL, 600, 1, 0, false);
        e.rest(2, MathTypes.Side.SELL, 600, 1, 0, false);
        uint256 n0 = e.mockCallCount();
        e.place(req(1, MathTypes.Side.BUY, 600, 3, 8));
        uint256 touches2;
        uint256 touches1;
        for (uint256 i = n0; i < e.mockCallCount(); ++i) {
            (MockAccountingPort.CallKind k, uint32 a,,,) = e.mockCalls(i);
            if (k == MockAccountingPort.CallKind.TOUCH && a == 2) ++touches2;
            if (k == MockAccountingPort.CallKind.TOUCH && a == 1) ++touches1;
        }
        assertEq(touches2, 1, "three fills, one maker touch");
        assertEq(touches1, 1);
    }

    /// G4 compatibility record: the exact accounting-port call sequence B issues for the direct
    /// 5x fill. Printed to the evidence log; A's real port must accept this order.
    function test_g4CallSequenceDirectFiveX() public {
        e = build(5);
        e.mockSetAccount(1, int256(120 * USDC), 0);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000, 0, false);
        uint256 n0 = e.mockCallCount();
        e.place(req(1, MathTypes.Side.BUY, 600, 1_000_000, 8));
        string[14] memory names = [
            "BEGIN",
            "TOUCH",
            "REPLACE",
            "POST_FILL",
            "BUMP_ACCOUNT_EPOCH",
            "BUMP_MARKET_EPOCH",
            "TAKEOVER",
            "POST_LIQ_FILL",
            "FLOOR_BEGIN",
            "FLOOR_COMPLETE",
            "FREEZE",
            "SNAPSHOT_CHUNK",
            "PAYOUT_CHUNK",
            "FINISH"
        ];
        // BEGIN; TOUCH taker; REPLACE taker (first-epoch sync); REPLACE taker (permit reserved);
        // TOUCH maker; REPLACE maker (reservation consumed); REPLACE taker (permit consumed);
        // POST_FILL with exact post-fill aggregates (integration R-05); REPLACE taker (permit
        // released at finish)
        uint8[9] memory expected = [0, 1, 2, 2, 1, 2, 2, 3, 2];
        uint256 n = e.mockCallCount() - n0;
        assertEq(n, 9);
        for (uint256 i; i < n; ++i) {
            (MockAccountingPort.CallKind k, uint32 a, uint32 b, uint256 x,) = e.mockCalls(n0 + i);
            console2.log(string.concat("G4-SEQ ", names[uint8(k)]), a, b, x);
            assertEq(uint8(k), expected[i]);
        }
    }
}
