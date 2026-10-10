pragma solidity ^0.8.30;

import {BookRiskEngineFixture} from "./BookRiskEngine.t.sol";
import {Book} from "../../src/Book.sol";
import {BookRiskEngine} from "../../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {PricingMode, RejectCode} from "../../src/math/RiskTypes.sol";
import {RiskContext, RiskPricing} from "../../src/pricing/RiskPricing.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";

/// Fast testnet startup: index warm-up quoting, parallel PERP/BASIS history from real funded
/// quotes and authenticated observations, and one-time pricing activation without the hourly
/// opening. Expected prices are hand-derived: INDEX 0.50 with impact 0.49/0.51; maker quotes at
/// 0.49/0.51 give impact mid floor((0.49 + 0.51) / 2) = 0.50, basis 0 and MARK 0.50.
contract FastStartupTest is BookRiskEngineFixture {
    address constant THIN = address(0x103);

    uint32 bidId;
    uint32 askId;

    function _index() internal {
        _indexAt(uint64(block.timestamp), 5e17);
    }

    function _indexAt(uint64 observedAt, uint256 midWad) internal {
        IPriceSource.Observation memory o =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        o.observedAt = observedAt;
        o.priceWad = midWad;
        o.impactBidWad = midWad - 1e16;
        o.impactAskWad = midWad + 1e16;
        engine.submitObservation(o, _signature(o, SIGNER_KEY));
    }

    function _post(address owner, bool buys, uint16 tick, uint64 lots) internal returns (uint32) {
        vm.prank(owner);
        return
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, buys, false, tick, lots, 8, 0));
    }

    function _quote() internal {
        bidId = _post(BUYER, true, 490, 500);
        askId = _post(SELLER, false, 510, 500);
        assertTrue(bidId != 0 && askId != 0, "funded warm-up quotes rest");
    }

    function _sample() internal returns (bool published) {
        vm.roll(block.number + 1);
        published = engine.samplePerp();
    }

    function _tryActivate() internal returns (bool) {
        try engine.activatePricing() {
            return true;
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), RiskPricing.PricingActivationUnavailable.selector);
            return false;
        }
    }

    function _fundAmount(address owner, uint256 atoms) internal {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, false);
        vm.stopPrank();
    }

    function testWarmupAcceptsOnlyFundedInBandPostOnlyRests() public {
        vm.chainId(10143);
        assertEq(_post(BUYER, true, 490, 500), 0, "no authenticated INDEX point yet");
        _index();
        RiskContext memory c = engine.riskContext();
        assertFalse(c.indexOk);
        (bool warm, uint256 point) = engine.warmupIndex();
        assertTrue(warm);
        assertEq(point, 5e17);
        _quote();
        // Warm-up depth is real, eligible funded depth around the INDEX point.
        BookRiskEngine.BookDepthQuote memory depth = engine.bookDepth();
        assertEq(depth.bidDepthLots, 500);
        assertEq(depth.askDepthLots, 500);
        assertEq(depth.bidWad, 49e16);
        assertEq(depth.askWad, 51e16);
        IBookRiskHooks.OrderKind[2] memory executable =
            [IBookRiskHooks.OrderKind.LIMIT, IBookRiskHooks.OrderKind.IOC];
        for (uint256 i; i < executable.length; ++i) {
            vm.prank(BUYER);
            uint32 id = engine.placeOrder(Book.Place(executable[i], true, false, 510, 100, 8, 0));
            assertEq(id, 0, "an executable order cannot use the warm-up path");
        }
        assertEq(engine.getOrder(askId).size, 500, "no warm-up quote traded");
        vm.expectRevert(Book.PostOnlyCrosses.selector);
        _post(BUYER, true, 510, 100);
        assertEq(_post(BUYER, true, 449, 100), 0, "outside the 0.05 band around the INDEX point");
        assertTrue(_post(BUYER, true, 450, 100) != 0, "band edge is inclusive");
        vm.prank(SELLER);
        assertEq(
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, true, true, 480, 100, 8, 0)),
            0,
            "reduce-only warm-up quote"
        );
        // 100 lots at 0.50 need 50,000 atoms. Halving admits only the fully backed prefix:
        // 100 -> 50 -> 25 -> 12 -> 6 -> 3 -> 1 (500 atoms); 3 lots would need 1,500.
        _fundAmount(THIN, 1000);
        uint32 thinId = _post(THIN, true, 500, 100);
        assertEq(engine.getOrder(thinId).size, 1);
        TradePreview.AccountPreview memory thin = engine.previewAccount(engine.participantId(THIN));
        assertEq(thin.orders.bidLots, 1);
        assertGe(thin.e0Q, 0);
        assertGe(thin.e1Q, 0);
        (uint256 longCap, uint256 shortCap) = engine.leverageCaps();
        assertEq(longCap, 1);
        assertEq(shortCap, 1);
    }

    function testWarmupIsUnavailableOutsideMonadTestnet() public {
        vm.chainId(143);
        _index();
        (bool warm,) = engine.warmupIndex();
        assertFalse(warm);
        assertEq(_post(BUYER, true, 490, 500), 0);
        assertEq(engine.bookDepth().bidDepthLots, 0);
    }

    function testWarmupQuoteCannotFillThroughBatch() public {
        vm.chainId(10143);
        _index();
        _quote();
        Book.Place[] memory places = new Book.Place[](1);
        places[0] = Book.Place(IBookRiskHooks.OrderKind.LIMIT, true, false, 510, 500, 8, 0);
        vm.prank(BUYER);
        uint32[] memory ids = engine.batch(new uint32[](0), places);
        assertEq(ids[0], 0);
        assertEq(engine.getOrder(askId).size, 500);
        TradePreview.OrderPreview memory preview =
            engine.previewOrder(engine.participantId(BUYER), MathTypes.Side.BUY, 510, 500, false);
        assertEq(
            uint8(preview.rejection), uint8(RejectCode.INVALID_PRICE_OR_SIZE), "taker preview stays closed"
        );
    }

    /// Launch with funded makers: INDEX, PERP and BASIS build in parallel and MARK activates on
    /// the first block where every 60-second window is complete, mid-epoch.
    function testParallelHistoryActivatesMarkMidEpoch() public {
        vm.chainId(10143);
        // The fixture activates at 1_000_000, 46:40 into an hour; this epoch ends at 1_000_800.
        _index();
        uint64 launch = uint64(block.timestamp);
        (uint64 epochIdBefore,,) = _epoch();
        _quote();
        uint64 activatedAt;
        for (uint256 i; i < 20 && activatedAt == 0; ++i) {
            _sample();
            if (_tryActivate()) activatedAt = uint64(block.timestamp);
            vm.warp(block.timestamp + 10);
            _index();
        }
        // Captures at t0, sealed by each newer INDEX point: PERP coverage starts at t0.
        assertEq(activatedAt - launch, 60, "first complete windows");
        RiskContext memory c = engine.riskContext();
        assertEq(uint8(c.pricingMode), uint8(PricingMode.NORMAL_PRICING));
        assertTrue(c.markOk);
        assertEq(c.markWad, 5e17);
        (uint64 epochIdAfter,,) = _epoch();
        assertEq(epochIdAfter, epochIdBefore, "activation does not open an epoch");
        assertEq(c.riskVersion, 1);
        // Collateral and leverage checks are unchanged by the earlier mark.
        (uint256 longCap,) = engine.leverageCaps();
        assertEq(longCap, 1, "uncalibrated profile stays 1x");
        _fundAmount(THIN, 1000);
        TradePreview.OrderPreview memory thin =
            engine.previewOrder(engine.participantId(THIN), MathTypes.Side.BUY, 510, 500, false);
        assertTrue(thin.acceptedCapLots < 500, "thin account cannot take 500 lots");
        vm.prank(THIN);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 510, 500, 8, 0));
        assertGe(engine.getOrder(askId).size, 500 - thin.acceptedCapLots, "fill bounded by collateral");
        TradePreview.AccountPreview memory after_ = engine.previewAccount(engine.participantId(THIN));
        assertGe(after_.e0Q, 0, "no-outcome endpoint stays backed");
        assertGe(after_.e1Q, 0, "yes-outcome endpoint stays backed");
    }

    function testCancelledQuoteRestartsWindowCoverage() public {
        vm.chainId(10143);
        _index();
        uint64 launch = uint64(block.timestamp);
        _quote();
        uint64 activatedAt;
        for (uint256 i; i < 30 && activatedAt == 0; ++i) {
            _sample();
            if (_tryActivate()) activatedAt = uint64(block.timestamp);
            uint64 elapsed = uint64(block.timestamp) - launch;
            if (elapsed == 20) {
                vm.prank(SELLER);
                engine.cancel(askId); // One side disappears for 40 seconds.
            }
            if (elapsed == 60) askId = _post(SELLER, false, 510, 500);
            vm.warp(block.timestamp + 10);
            _index();
        }
        // The 20 s capture is discarded by the cancel, one-sided captures record unavailable
        // PERP from 30 s, and the 60 s capture predates the requote. Coverage restarts with the
        // 70 s capture, so the windows complete at 130 s.
        assertGt(activatedAt, 0);
        assertEq(activatedAt - launch, 130, "a full new window after the requote");
    }

    function testRestartGapRequiresFreshFullWindows() public {
        vm.chainId(10143);
        _index();
        uint64 launch = uint64(block.timestamp);
        _quote();
        for (uint256 i; i < 4; ++i) {
            _sample();
            vm.warp(block.timestamp + 10);
            _index();
        }
        // Publisher and keeper stop for 45 seconds; quotes stay resting.
        vm.warp(block.timestamp + 45);
        assertFalse(engine.riskContext().indexOk);
        (bool warm,) = engine.warmupIndex();
        assertFalse(warm, "no fresh reference while the publisher is down");
        assertEq(engine.bookDepth().bidDepthLots, 0, "no depth without a fresh reference");
        assertFalse(_tryActivate());
        _index();
        uint64 restart = uint64(block.timestamp);
        uint64 activatedAt;
        for (uint256 i; i < 20 && activatedAt == 0; ++i) {
            _sample();
            if (_tryActivate()) activatedAt = uint64(block.timestamp);
            vm.warp(block.timestamp + 10);
            _index();
        }
        assertEq(activatedAt - restart, 60, "history after the gap is rebuilt, never manufactured");
        assertGt(restart - launch, 45);
    }

    function testDelayedObservationsKeepTheirOwnTimestamps() public {
        vm.chainId(10143);
        _index();
        _quote();
        uint64 launch = uint64(block.timestamp);
        uint64 activatedAt;
        for (uint256 i; i < 20 && activatedAt == 0; ++i) {
            _sample();
            if (_tryActivate()) activatedAt = uint64(block.timestamp);
            vm.warp(block.timestamp + 10);
            // Every observation lands 8 seconds after it was observed.
            _indexAt(uint64(block.timestamp) - 8, 5e17);
        }
        // Coverage is anchored to observedAt; the late delivery shifts sealing by one interval.
        assertGt(activatedAt, 0);
        assertLe(activatedAt - launch, 70);
        assertGe(activatedAt - launch, 60);
    }

    function testActivationNeedsActiveReadyAccounting() public {
        vm.chainId(10143);
        vm.warp(1_000_740); // 60 seconds before the 1_000_800 epoch end.
        _index();
        _quote();
        for (uint256 i; i < 6; ++i) {
            _sample();
            vm.warp(block.timestamp + 10);
            _index();
        }
        vm.warp(1_000_800);
        _index();
        assertFalse(_tryActivate(), "an expired epoch is not READY accounting");
        BookRiskEngine fresh = new BookRiskEngine(vault, TREASURY, configuration);
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        fresh.activatePricing();
    }

    function _epoch() internal view returns (uint64 id, uint64 start, uint64 end) {
        (id, start, end,,,,) = engine.epoch();
    }
}
