// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {OrderLifecycle} from "../../../src/risk/OrderLifecycle.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Side, RejectCode} from "../../../provisional/MathTypes.sol";
import {BookRiskAdapter} from "../../../src/risk/BookRiskAdapter.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract LifeEngine is OrderLifecycle, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function feed(uint64 from, uint64 to, uint256 idx, uint256 bid, uint256 ask) external {
        for (uint64 t = from; t <= to; t += 10) {
            _onIndexObservation(t, idx, true);
            _recordPerp(t, bid, ask, 1e6, 1e6);
        }
    }

    function openEpoch() external {
        _riskEpochOpenedWithGuards();
    }

    function place(IBookRiskHooks.OrderRequest memory r) external returns (PlaceResult memory res) {
        res = _mockPlace(r);
        _mockEndAction();
    }

    function rest(uint32 owner, Side side, uint16 tick, uint64 lots, uint32 expiry, bool ro)
        external
        returns (uint32 s)
    {
        s = _mockRest(owner, side, tick, lots, expiry, ro);
        _mockEndAction();
    }

    /// Generation-checked cancel: a stale public id (old generation) is a no-op.
    function cancelKey(uint32 slot, uint24 gen) external returns (bool ok) {
        if (_bk[slot - 1].v.key.generation != gen) return false;
        ok = _mockCancel(slot);
        _mockEndAction();
    }

    function recycle(uint32 slot, uint32 owner, Side side, uint16 tick, uint64 lots) external {
        RiskSnapshot memory snap = _riskBeginAction();
        (EpochTag memory tag, uint64 rv, uint256 fee) =
            _riskAdmitRest(snap, owner, side, tick, lots, 0, false);
        _mockRecycle(slot, OrderView(OrderKey(slot, 0), owner, side, tick, lots, 0, tag, false, rv, fee));
        _mockEndAction();
    }

    function amendDown(uint32 slot, uint64 newLots) external {
        RiskSnapshot memory snap = _riskBeginAction();
        BookOrder storage o = _bk[slot - 1];
        uint256 fee = _riskAmendDown(snap, o.v, newLots);
        o.v.remainingLots = newLots;
        o.v.remainingFeeCapQ = fee;
        _mockEndAction();
    }

    function cancelAll(uint32 t) external {
        _cancelAllTopLevel(t);
        _mockEndAction();
    }

    function classify(OrderTerms memory a, OrderTerms memory b) external pure returns (AmendKind) {
        return _classifyAmend(a, b);
    }

    function sums(uint32 t) external view returns (OA.OrderSums memory) {
        return _resSums(t);
    }

    function orderAt(uint32 slot) external view returns (OrderView memory v, bool live) {
        return (_bk[slot - 1].v, _bk[slot - 1].live);
    }
}

/// B025: reductions and order amendments with real B hooks, mock book and scripted A port.
contract B025Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    LifeEngine e;

    function setUp() public {
        vm.warp(L0);
        e = new LifeEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
        for (uint32 t = 1; t <= 6; ++t) {
            e.mockSetAccount(t, int256(400 * USDC), 0);
        }
    }

    function req(uint32 trader, Side side, uint16 limit, uint64 lots, bool ro)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(trader, side, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, ro, 8);
    }

    function test_reduceOnly10AgainstLong3() public {
        e.mockSetAccount(1, int256(400 * USDC), 10);
        uint32 slot = e.rest(1, Side.SELL, 600, 10, 0, true); // reduce-only sell against long 10
        e.mockSetAccount(1, int256(400 * USDC), 3); // unrelated trade shrank the position to 3
        MockBookAdapter.PlaceResult memory r = e.place(req(2, Side.BUY, 600, 10, false));
        assertEq(r.filledLots, 3, "fills at most 3");
        assertEq(e.mockAccount(1).lots, 0, "flat, no short flip");
        (, bool live) = e.orderAt(slot);
        assertFalse(live, "remaining 7 removed");
        OA.OrderSums memory s = e.sums(1);
        assertEq(s.askLots, 0, "7 released exactly once (3 consumed by the fill)");
        assertEq(s.askValueQ, 0);
    }

    function test_noRevivalLongFlatShortLong() public {
        e.mockSetAccount(1, int256(400 * USDC), 10);
        uint32 slot = e.rest(1, Side.SELL, 600, 5, 0, true);
        // position independently goes long -> flat -> short -> long: version bumps at each sign change
        e.place(req(1, Side.SELL, 590, 10, false)); // no bids: nothing
        e.mockSetAccount(1, int256(400 * USDC), 10);
        e.rest(3, Side.BUY, 600, 10, 0, false);
        e.place(req(1, Side.SELL, 600, 10, false)); // long 10 -> flat
        e.rest(4, Side.BUY, 600, 5, 0, false);
        e.place(req(1, Side.SELL, 600, 5, false)); // flat -> short 5
        e.rest(5, Side.SELL, 610, 10, 0, false);
        e.place(req(1, Side.BUY, 610, 10, false)); // short 5 -> long 5
        assertEq(e.mockAccount(1).lots, 5);
        // the old reduce-only sell now faces a long again, but its version is stale
        vm.expectEmit(true, false, false, true, address(e));
        emit BookRiskAdapter.MakerPruned(1, slot, RejectCode.STALE_ORDER);
        MockBookAdapter.PlaceResult memory r = e.place(req(2, Side.BUY, 600, 5, false));
        assertEq(r.filledLots, 0, "old reduce-only order cannot revive");
        (, bool live) = e.orderAt(slot);
        assertFalse(live, "pruned as stale");
    }

    function test_expiryInclusive() public {
        vm.roll(50);
        e.rest(1, Side.SELL, 600, 5, 50, false);
        assertEq(e.place(req(2, Side.BUY, 600, 5, false)).filledLots, 5, "executable at K");
        e.rest(1, Side.SELL, 600, 5, 50, false);
        vm.roll(51);
        assertEq(e.place(req(2, Side.BUY, 600, 5, false)).filledLots, 0, "stale at K+1");
    }

    function test_staleGenerationCannotTouchReusedSlot() public {
        uint32 slot = e.rest(1, Side.SELL, 600, 5, 0, false);
        (IBookRiskHooks.OrderView memory v,) = e.orderAt(slot);
        uint24 oldGen = v.key.generation;
        assertTrue(e.cancelKey(slot, oldGen));
        e.recycle(slot, 2, Side.SELL, 620, 7); // slot reused by trader 2, generation + 1
        assertFalse(e.cancelKey(slot, oldGen), "stale id is a no-op");
        assertEq(e.sums(2).askLots, 7, "new live order untouched");
        (, bool live) = e.orderAt(slot);
        assertTrue(live);
    }

    function test_sizeDownKeepsPriorityReleasesDelta() public {
        uint32 slot = e.rest(1, Side.SELL, 600, 10, 0, false);
        e.rest(2, Side.SELL, 600, 10, 0, false);
        e.amendDown(slot, 4);
        assertEq(e.sums(1).askLots, 4);
        assertEq(e.sums(1).askValueQ, 4 * 600 * Q);
        // still first in queue at 600
        MockBookAdapter.PlaceResult memory r = e.place(req(3, Side.BUY, 600, 4, false));
        assertEq(r.filledLots, 4);
        assertEq(e.mockAccount(1).lots, -4, "the amended order kept its priority");
    }

    function test_widenedPermissionsReplace() public view {
        OrderLifecycle.OrderTerms memory o = OrderLifecycle.OrderTerms(Side.SELL, 600, 10, 100, true);
        assertEq(uint8(e.classify(o, OrderLifecycle.OrderTerms(Side.SELL, 600, 6, 100, true))), 0); // SIZE_DOWN
        assertEq(uint8(e.classify(o, OrderLifecycle.OrderTerms(Side.SELL, 600, 12, 100, true))), 1); // size up
        assertEq(uint8(e.classify(o, OrderLifecycle.OrderTerms(Side.SELL, 601, 6, 100, true))), 1); // new price
        assertEq(uint8(e.classify(o, OrderLifecycle.OrderTerms(Side.SELL, 600, 6, 200, true))), 1); // later expiry
        assertEq(uint8(e.classify(o, OrderLifecycle.OrderTerms(Side.SELL, 600, 6, 50, true))), 1); // shorter expiry
        assertEq(uint8(e.classify(o, OrderLifecycle.OrderTerms(Side.SELL, 600, 6, 100, false))), 1); // drops reduce-only
        assertEq(uint8(e.classify(o, o)), 2);
    }

    function test_cancelAllThenLazyPrune() public {
        e.rest(1, Side.SELL, 600, 5, 0, false);
        e.rest(1, Side.SELL, 610, 5, 0, false);
        e.cancelAll(1);
        e.rest(1, Side.SELL, 620, 3, 0, false);
        assertEq(e.sums(1).askLots, 3);
        // a taker walking the book prunes the two stale nodes (steps consumed) and fills the new one
        MockBookAdapter.PlaceResult memory r = e.place(req(2, Side.BUY, 620, 3, false));
        assertEq(r.filledLots, 3);
        assertEq(e.lastExamined(), 3);
        assertEq(e.sums(1).askLots, 0, "old-epoch pruning subtracted nothing");
    }

    function test_crossedLimitRemainderDropped() public {
        e.rest(1, Side.SELL, 600, 2, 0, false);
        e.rest(2, Side.SELL, 600, 2, 0, false);
        IBookRiskHooks.OrderRequest memory r = req(3, Side.BUY, 600, 4, false);
        r.kind = IBookRiskHooks.OrderKind.LIMIT;
        r.maxSteps = 1;
        MockBookAdapter.PlaceResult memory res = e.place(r);
        assertEq(res.filledLots, 2);
        assertEq(res.restedSlot, 0);
        assertEq(e.sums(3).bidLots, 0, "dropped remainder leaves no reservation");
    }
}
