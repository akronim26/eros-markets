// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TradePreview} from "../../../src/risk/TradePreview.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {Side, RejectCode, AccountingState, PricingMode} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract PreviewEngine is TradePreview, MockBookAdapter, MockAccountingPort {
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

    function rest(uint32 owner, Side side, uint16 tick, uint64 lots) external returns (uint32 s) {
        s = _mockRest(owner, side, tick, lots, 0, false);
        _mockEndAction();
    }
}

/// B026: previews agree with execution at the same immutable context.
contract B026Test is Test {
    uint256 constant USDC = 1e24;
    uint256 constant Q = 1e18;
    uint64 constant L0 = 1_000_000;
    PreviewEngine e;

    function build(bool withPerp) internal {
        vm.warp(L0);
        e = new PreviewEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        e.init(l, RiskFixture.profile(5, true));
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, withPerp ? 59e16 : 0, withPerp ? 61e16 : 0);
        e.openEpoch();
        e.mockSetAccount(1, int256(120 * USDC), 0);
        e.mockSetAccount(2, int256(4000 * USDC), 0);
    }

    function ioc(uint32 t, Side s, uint16 limit, uint64 lots)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(t, s, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, false, 8);
    }

    function test_previewMatchesExecutionCapAndCollateral() public {
        build(true);
        e.rest(2, Side.SELL, 600, 3_000_000);
        TradePreview.OrderPreview memory p = e.previewOrder(1, Side.BUY, 600, 2_000_000, false);
        assertEq(p.acceptedCapLots, 1_000_000);
        assertEq(p.requiredImQ, 120 * USDC, "required collateral = IM envelope");
        assertEq(p.eMinQ, int256(120 * USDC));
        assertTrue(p.id.markAvailable);
        MockBookAdapter.PlaceResult memory r = e.place(ioc(1, Side.BUY, 600, 2_000_000));
        assertEq(r.filledLots, p.acceptedCapLots, "execution fills exactly the previewed cap");
    }

    function test_bootstrapSameSemantics() public {
        build(false);
        e.mockSetAccount(3, int256(600 * 1000 * Q), 0);
        TradePreview.OrderPreview memory p = e.previewOrder(3, Side.BUY, 600, 4000, false);
        assertEq(uint8(p.id.pricingMode), uint8(PricingMode.BOOTSTRAP));
        assertFalse(p.id.markAvailable, "unavailable mark flagged, not 0-priced");
        assertEq(p.acceptedCapLots, 1000);
        assertTrue(p.fullBackingRequired);
        e.rest(2, Side.SELL, 600, 5000);
        assertEq(e.place(ioc(3, Side.BUY, 600, 4000)).filledLots, 1000);
    }

    function test_sweepRejectionSameAsExecution() public {
        build(true);
        e.mockSetState(AccountingState.ROLLOVER_SWEEP);
        TradePreview.OrderPreview memory p = e.previewOrder(1, Side.BUY, 600, 10, false);
        assertEq(uint8(p.rejection), uint8(RejectCode.BAD_STAGE));
        MockBookAdapter.PlaceResult memory r = e.place(ioc(1, Side.BUY, 600, 10));
        assertEq(uint8(r.rejection), uint8(RejectCode.BAD_STAGE));
        (bool ok, RejectCode why) = e.previewRelease(2, 1);
        assertFalse(ok);
        assertEq(uint8(why), uint8(RejectCode.BAD_STAGE));
    }

    function test_staleIndexSameAsExecution() public {
        build(true);
        vm.warp(L0 + 12 hours + 400); // index window no longer covered
        TradePreview.OrderPreview memory p = e.previewOrder(1, Side.BUY, 600, 10, false);
        assertEq(uint8(p.rejection), uint8(RejectCode.INVALID_PRICE_OR_SIZE));
        assertFalse(p.id.indexAvailable);
        assertEq(uint8(e.place(ioc(1, Side.BUY, 600, 10)).rejection), uint8(RejectCode.INVALID_PRICE_OR_SIZE));
    }

    function test_projectionsLabelledNotApplied() public {
        build(true);
        e.mockSetProjection(1, int256(3 * Q), 2 * Q);
        TradePreview.AccountPreview memory a = e.previewAccount(1);
        assertEq(a.projectedFundingQ, int256(3 * Q));
        assertEq(a.projectedPremiumQ, 2 * Q);
        assertTrue(a.projectionsAreEstimates);
        assertEq(a.cashQ, int256(120 * USDC), "projection is not folded into authoritative cash");
    }

    function test_accountPreviewAfterDirectFiveX() public {
        build(true);
        e.rest(2, Side.SELL, 600, 1_000_000);
        e.place(ioc(1, Side.BUY, 600, 1_000_000));
        TradePreview.AccountPreview memory a = e.previewAccount(1);
        assertEq(uint8(a.status), uint8(MarginMath.Status.HEALTHY));
        assertEq(a.imQ, 120 * USDC);
        assertEq(a.markEquityQ, int256(120 * USDC));
        assertEq(a.e0Q, -int256(480 * USDC));
        assertEq(a.usableReleaseAtoms, 0, "no release while exactly at IM");
    }

    function test_usableReleaseMatchesDecision() public {
        build(true);
        TradePreview.AccountPreview memory a = e.previewAccount(2);
        assertEq(a.usableReleaseAtoms, 4000 * 1e6, "flat account can release all whole atoms");
        e.rest(2, Side.SELL, 600, 1_000_000); // short commitment reserves collateral
        a = e.previewAccount(2);
        assertLt(a.usableReleaseAtoms, 4000 * 1e6);
        (bool ok,) = e.previewRelease(2, a.usableReleaseAtoms);
        assertTrue(ok);
        (ok,) = e.previewRelease(2, a.usableReleaseAtoms + 1);
        assertFalse(ok);
    }
}
