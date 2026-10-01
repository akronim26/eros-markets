// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {BookRiskAdapter} from "../../../src/risk/BookRiskAdapter.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {IAccountingPort} from "../../../provisional/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Side, RejectCode} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// Real B hooks + mock book + scripted A accounting (no real A code).
contract TradeEngine is BookRiskAdapter, MockBookAdapter, MockAccountingPort {
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

    function cancel(uint32 slot) external returns (bool ok) {
        ok = _mockCancel(slot);
        _mockEndAction();
    }

    function sums(uint32 t) external view returns (OA.OrderSums memory) {
        return _resSums(t);
    }
}

/// Shared market fixture for W4/W5 suites: 29 days to T, mark 0.60, leverage cap 5.
abstract contract TradeFixture is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    TradeEngine e;
    FormulaCoverage cov;

    function setUpMarket() internal {
        vm.warp(L0);
        e = new TradeEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        e.init(l, RiskFixture.profile(5, true));
        cov = new FormulaCoverage(100_000 * USDC, 2_000 * USDC);
        e.mockSetCoverageScript(cov);
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
    }

    function buy(uint32 trader, uint16 limit, uint64 lots, uint16 steps, IBookRiskHooks.OrderKind kind)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory r)
    {
        r = IBookRiskHooks.OrderRequest(trader, Side.BUY, kind, limit, lots, 0, false, steps);
    }
}

/// B024: bounded internal book adapter.
contract B024Test is TradeFixture {
    function setUp() public {
        setUpMarket();
        e.mockSetAccount(1, int256(120 * USDC), 0);
        e.mockSetAccount(2, int256(400 * USDC), 0);
        e.mockSetAccount(3, int256(400 * USDC), 0);
        e.mockSetAccount(4, int256(400 * USDC), 0);
    }

    function test_directFiveXThroughBook() public {
        e.rest(2, Side.SELL, 600, 1_000_000, 0, false);
        MockBookAdapter.PlaceResult memory r =
            e.place(buy(1, 600, 1_000_000, 8, IBookRiskHooks.OrderKind.IOC));
        assertEq(r.filledLots, 1_000_000, "admitted and filled, not stopped");
        assertEq(e.mockAccount(1).cashQ, -int256(480 * USDC));
        assertEq(e.mockAccount(2).cashQ, int256(1000 * USDC));
        assertEq(e.sums(2).askLots, 0, "maker reservation consumed exactly once");
        (uint128 bl,,,,,,) = e.mockContribution(1);
        assertEq(bl, 0, "taker permit released");
    }

    function test_twoMakerFragmentation() public {
        e.rest(2, Side.SELL, 600, 400_000, 0, false);
        e.rest(3, Side.SELL, 600, 600_000, 0, false);
        MockBookAdapter.PlaceResult memory r =
            e.place(buy(1, 600, 1_000_000, 8, IBookRiskHooks.OrderKind.IOC));
        assertEq(r.filledLots, 1_000_000);
        assertEq(e.mockAccount(1).lots, 1_000_000);
        assertEq(e.mockAccount(2).lots + e.mockAccount(3).lots, -1_000_000);
    }

    function test_staleSelfExpiredConsumeSteps() public {
        vm.roll(100);
        e.rest(2, Side.SELL, 600, 10, 99, false); // expires before now
        e.rest(1, Side.SELL, 600, 10, 0, false); // taker's own order
        e.rest(3, Side.SELL, 600, 10, 0, false); // valid, but beyond the 2-step budget
        MockBookAdapter.PlaceResult memory r = e.place(buy(1, 600, 30, 2, IBookRiskHooks.OrderKind.IOC));
        assertEq(e.lastExamined(), 2, "expired and self consumed both steps");
        assertEq(r.filledLots, 0);
        (, bool live) = e.mockOrder(3);
        assertTrue(live, "third node never examined");
    }

    function test_expectedPruneKeepsPriorFills() public {
        e.rest(2, Side.SELL, 600, 10, 0, false);
        e.mockSetAccount(5, int256(1 * USDC), 0);
        e.rest(5, Side.SELL, 600, 1, 0, false); // tiny exactly backed ask
        e.mockSetAccount(5, 0, 0); // cash later disappears (scripted): maker now fails readmission
        e.rest(3, Side.SELL, 600, 10, 0, false);
        MockBookAdapter.PlaceResult memory r = e.place(buy(1, 600, 21, 8, IBookRiskHooks.OrderKind.IOC));
        assertEq(r.filledLots, 20, "fills before and after the pruned maker persist");
        (, bool live) = e.mockOrder(2);
        assertFalse(live, "failed maker pruned");
    }

    function test_unexpectedFailureRevertsWholeTransaction() public {
        e.rest(2, Side.SELL, 600, 10, 0, false);
        e.rest(3, Side.SELL, 600, 10, 0, false);
        e.mockFailPostAt(2);
        vm.recordLogs();
        vm.expectRevert(
            abi.encodeWithSelector(
                MockAccountingPort.MockSequence.selector, "injected accounting invariant failure"
            )
        );
        e.place(buy(1, 600, 20, 8, IBookRiskHooks.OrderKind.IOC));
        assertEq(e.mockAccount(1).lots, 0, "first fill rolled back too");
        assertEq(e.mockAccount(2).lots, 0);
        (, bool live) = e.mockOrder(1);
        assertTrue(live);
    }

    function test_noDuplicateUnrestOnFilledSize() public {
        uint32 slot = e.rest(2, Side.SELL, 600, 10, 0, false);
        e.place(buy(1, 600, 4, 8, IBookRiskHooks.OrderKind.IOC));
        assertEq(e.sums(2).askLots, 6);
        assertTrue(e.cancel(slot));
        assertEq(e.sums(2).askLots, 0, "only the unfilled 6 released; a second release would underflow");
        assertEq(e.sums(2).askValueQ, 0);
    }

    function test_iocNoLiquidityReleasesPermit() public {
        MockBookAdapter.PlaceResult memory r = e.place(buy(1, 600, 1000, 8, IBookRiskHooks.OrderKind.IOC));
        assertEq(r.filledLots, 0);
        (uint128 bl,,,,,,) = e.mockContribution(1);
        assertEq(bl, 0);
        assertEq(e.sums(1).bidLots, 0, "no persistent commitment");
    }

    function test_limitRemainderConvertsPermitOnce() public {
        e.rest(2, Side.SELL, 600, 4, 0, false);
        MockBookAdapter.PlaceResult memory r = e.place(buy(1, 590, 10, 8, IBookRiskHooks.OrderKind.LIMIT));
        assertEq(r.filledLots, 0, "limit below the ask");
        assertGt(r.restedSlot, 0);
        OA.OrderSums memory s = e.sums(1);
        assertEq(s.bidLots, 10);
        assertEq(s.bidValueQ, 10 * 590 * Q, "reserved once at the limit");
    }

    function test_stepCapEnforced() public {
        vm.expectRevert(MockBookAdapter.MockBookBadInput.selector);
        e.place(buy(1, 600, 1, 65, IBookRiskHooks.OrderKind.IOC));
    }
}
