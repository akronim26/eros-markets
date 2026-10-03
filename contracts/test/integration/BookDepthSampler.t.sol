pragma solidity ^0.8.30;

import {BookRiskEngineFixture} from "./BookRiskEngine.t.sol";
import {Book} from "../../src/Book.sol";
import {BookRiskEngine} from "../../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {PricingMath} from "../../src/math/PricingMath.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {PriceIngress} from "../../src/pricing/PriceIngress.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {Vm} from "forge-std/Vm.sol";

interface IBookDepthEngine {
    struct Quote {
        uint256 bidWad;
        uint256 askWad;
        uint256 bidDepthLots;
        uint256 askDepthLots;
        uint16 examined;
        bytes32 fingerprint;
    }

    function samplePerp() external returns (bool);
    function bookDepth() external view returns (Quote memory);
}

contract DepthEligibilityHarness is BookRiskEngine {
    constructor(CollateralVault vault, address treasury, IMarketConfig.Listing memory configuration)
        BookRiskEngine(vault, treasury, configuration)
    {}

    function setCashForTest(address owner, int256 cashQ) external {
        accounts[owner].value.cashQ = cashQ;
    }
}

contract BookDepthSamplerTest is BookRiskEngineFixture {
    function _placeDepth(address owner, bool buys, uint16 tick, uint64 lots, uint32 expiry)
        internal
        returns (uint32)
    {
        vm.prank(owner);
        return
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, buys, false, tick, lots, 8, expiry));
    }

    function _sampleDepth() internal returns (bool) {
        return IBookDepthEngine(address(engine)).samplePerp();
    }

    function _publishDepth() internal {
        vm.roll(block.number + 1);
        _sampleDepth();
        vm.warp(block.timestamp + 10);
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertTrue(_sampleDepth());
    }

    function _submitNextIndex() internal {
        IPriceSource.Observation memory observation =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
    }

    function _assertPerpRecord(uint64 capturedAt, bool expectedValid) internal {
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 found;
        for (uint256 logIndex; logIndex < entries.length; ++logIndex) {
            if (
                entries[logIndex].topics[0]
                    != keccak256("PerpObservationRecorded(uint64,uint256,bool,int256,bool)")
            ) continue;
            (uint64 observedAt,, bool valid, int256 basisWad, bool basisValid) =
                abi.decode(entries[logIndex].data, (uint64, uint256, bool, int256, bool));
            assertEq(observedAt, capturedAt);
            assertEq(valid, expectedValid);
            assertEq(basisValid, expectedValid);
            assertEq(basisWad, 0);
            ++found;
        }
        assertEq(found, 1);
    }

    function _seedDepth() internal {
        _placeDepth(BUYER, true, 490, 500, 0);
        _placeDepth(SELLER, false, 510, 500, 0);
    }

    function testColdStartupPlacesMatchesAndCancelsBeforePerpWarmup() public {
        _warmIndex();
        uint32 bidId = _placeDepth(BUYER, true, 490, 500, 0);
        uint32 askId = _placeDepth(SELLER, false, 510, 500, 0);
        assertFalse(_sampleDepth());
        assertEq(engine.ringCount(1), 0);
        vm.prank(BUYER);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 510, 100, 8, 0));
        assertEq(engine.getOrder(askId).size, 400);
        vm.prank(BUYER);
        engine.cancel(bidId);
        assertEq(engine.getOrder(bidId).size, 0);
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.BOOTSTRAP));
        assertFalse(engine.riskContext().markOk);
    }

    function testDepthUsesExactNMultiLevelNotionalNotBestLevelOrLastTick() public {
        _warmIndex();
        _placeDepth(BUYER, true, 490, 200, 0);
        _placeDepth(BUYER, true, 480, 1000, 0);
        _placeDepth(SELLER, false, 510, 200, 0);
        _placeDepth(SELLER, false, 520, 1000, 0);
        IBookDepthEngine.Quote memory quote = IBookDepthEngine(address(engine)).bookDepth();
        assertEq(quote.bidWad, 484e15);
        assertEq(quote.askWad, 516e15);
        assertEq(quote.bidDepthLots, 500);
        assertEq(quote.askDepthLots, 500);
        assertEq(quote.examined, 4);
        _publishDepth();
    }

    function testThreeLotImpactBidFloorsAndAskCeils() public {
        configuration.depthNLots = 3;
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        _fund(BUYER);
        _fund(SELLER);
        vm.prank(GOVERNOR);
        engine.activateMarket();
        _warmIndex();
        _placeDepth(BUYER, true, 491, 2, 0);
        _placeDepth(BUYER, true, 490, 1, 0);
        _placeDepth(SELLER, false, 510, 1, 0);
        _placeDepth(SELLER, false, 511, 2, 0);
        IBookDepthEngine.Quote memory quote = IBookDepthEngine(address(engine)).bookDepth();
        assertEq(quote.bidWad, 490666666666666666);
        assertEq(quote.askWad, 510666666666666667);
        assertEq(quote.bidDepthLots, 3);
        assertEq(quote.askDepthLots, 3);
        _publishDepth();
    }

    function testSameBlockCannotPublishItsCapturedDepth() public {
        _warmIndex();
        _seedDepth();
        assertFalse(_sampleDepth());
        vm.expectRevert();
        _sampleDepth();
        assertEq(engine.ringCount(1), 0);
        vm.warp(block.timestamp + 1);
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertTrue(_sampleDepth());
    }

    function testUnsealedCaptureWaitsWithoutPublishingOrChangingItsTimestamp() public {
        _warmIndex();
        _seedDepth();
        uint64 capturedAt = uint64(block.timestamp);
        assertFalse(_sampleDepth());
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        assertEq(engine.ringCount(1), 0);
        assertEq(engine.ringCount(2), 0);
        for (uint256 offset = 1; offset <= 2; ++offset) {
            vm.warp(capturedAt + offset);
            vm.roll(block.number + 1);
            assertFalse(_sampleDepth());
            assertEq(engine.ringCount(1), 0);
            assertEq(engine.ringCount(2), 0);
        }
        vm.warp(capturedAt + 10);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertTrue(_sampleDepth());
        _assertPerpRecord(capturedAt, true);
        assertEq(engine.ringCount(1), 1);
        assertEq(engine.ringCount(2), 1);
    }

    function testSealedPublicationRejectsAuthenticatedCaptureTimeCorrection() public {
        _warmIndex();
        _seedDepth();
        uint64 capturedAt = uint64(block.timestamp);
        _sampleDepth();
        vm.warp(capturedAt + 10);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertTrue(_sampleDepth());
        _assertPerpRecord(capturedAt, true);

        IPriceSource.Observation memory correction =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        correction.observedAt = capturedAt;
        correction.priceWad = 6e17;
        correction.impactBidWad = 59e16;
        correction.impactAskWad = 61e16;
        bytes memory signature = _signature(correction, SIGNER_KEY);
        vm.expectRevert(PriceIngress.BackwardsObservation.selector);
        engine.submitObservation(correction, signature);
        correction.observedAt = capturedAt - 1;
        signature = _signature(correction, SIGNER_KEY);
        vm.expectRevert(PriceIngress.BackwardsObservation.selector);
        engine.submitObservation(correction, signature);
        assertEq(engine.sourceState(configuration.indexSourceId).lastObservedAt, capturedAt + 10);
        PricingMath.Twap memory basisBefore = engine.basisTwap900(capturedAt + 10);
        assertFalse(basisBefore.available);
        assertEq(basisBefore.coveredSecs, 10);
        assertEq(basisBefore.integral, 0);
        correction.observedAt = capturedAt + 10;
        engine.submitObservation(correction, _signature(correction, SIGNER_KEY));
        assertEq(engine.sourceState(configuration.indexSourceId).lastSequence, correction.sequence);
        PricingMath.Twap memory basisAfter = engine.basisTwap900(capturedAt + 10);
        assertFalse(basisAfter.available);
        assertEq(basisAfter.coveredSecs, basisBefore.coveredSecs);
        assertEq(basisAfter.integral, basisBefore.integral);
        assertEq(engine.ringCount(1), 1);
        assertEq(engine.ringCount(2), 1);
    }

    function testDelayedIndexBackfillBeforeSealInvalidatesCapture() public {
        _warmIndex();
        _seedDepth();
        vm.warp(block.timestamp + 5);
        uint64 capturedAt = uint64(block.timestamp);
        _sampleDepth();
        vm.warp(capturedAt + 5);
        IPriceSource.Observation memory delayed =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        delayed.observedAt = capturedAt - 1;
        delayed.priceWad = 501e15;
        delayed.impactBidWad = 491e15;
        delayed.impactAskWad = 511e15;
        engine.submitObservation(delayed, _signature(delayed, SIGNER_KEY));
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(capturedAt, false);
    }

    function testWaitingCaptureExpiresRatherThanRenewingObservationTime() public {
        _warmIndex();
        _seedDepth();
        uint64 capturedAt = uint64(block.timestamp);
        _sampleDepth();
        vm.warp(capturedAt + 20);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        assertEq(engine.ringCount(1), 0);
        vm.warp(capturedAt + 31);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(capturedAt, false);
    }

    function testLaterInvalidIndexCannotPublishThroughUnavailableCurrentWindow() public {
        _warmIndex();
        _seedDepth();
        uint64 capturedAt = uint64(block.timestamp);
        _sampleDepth();
        vm.warp(capturedAt + 10);
        IPriceSource.Observation memory invalid =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        invalid.bidDepthLots = 0;
        engine.submitObservation(invalid, _signature(invalid, SIGNER_KEY));
        vm.warp(capturedAt + 11);
        assertFalse(engine.riskContext().indexOk);
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(capturedAt, false);
    }

    function testMutationOnEitherSideInvalidatesPendingCapture() public {
        _warmIndex();
        _seedDepth();
        _sampleDepth();
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        _placeDepth(SELLER, false, 520, 1, 0);
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        _placeDepth(BUYER, true, 480, 1, 0);
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        vm.warp(block.timestamp + 1);
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertTrue(_sampleDepth());
    }

    function testLaterIndexSamplesDoNotStarvePriorBlockPromotion() public {
        _warmIndex();
        _seedDepth();
        _sampleDepth();
        vm.warp(block.timestamp + 1);
        IPriceSource.Observation memory observation = _observation(32);
        engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
        vm.roll(block.number + 1);
        assertTrue(_sampleDepth());
    }

    function testRevisedCaptureTimeIndexCheckpointRejectsPromotion() public {
        _warmIndex();
        _seedDepth();
        _sampleDepth();
        IPriceSource.Observation memory observation = _observation(32);
        observation.priceWad = 501e15;
        observation.impactBidWad = 491e15;
        observation.impactAskWad = 511e15;
        engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
    }

    function testPromotionRetainsOriginalCaptureTimeAndCannotLaunderExpiry() public {
        _warmIndex();
        _seedDepth();
        uint64 capturedAt = uint64(block.timestamp);
        _sampleDepth();
        vm.warp(block.timestamp + 30);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertTrue(_sampleDepth());
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bool found;
        for (uint256 logIndex; logIndex < entries.length; ++logIndex) {
            if (
                entries[logIndex].topics[0]
                    != keccak256("PerpObservationRecorded(uint64,uint256,bool,int256,bool)")
            ) continue;
            (uint64 observedAt,, bool valid,,) =
                abi.decode(entries[logIndex].data, (uint64, uint256, bool, int256, bool));
            assertEq(observedAt, capturedAt);
            assertTrue(valid);
            found = true;
        }
        assertTrue(found);
        vm.warp(block.timestamp + 31);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
    }

    function testExpiredAndCancelledOrdersNeverCountAsDepth() public {
        _warmIndex();
        _placeDepth(BUYER, true, 490, 500, uint32(block.number));
        _placeDepth(SELLER, false, 510, 500, 0);
        assertEq(IBookDepthEngine(address(engine)).bookDepth().bidDepthLots, 500);
        vm.roll(block.number + 1);
        assertEq(IBookDepthEngine(address(engine)).bookDepth().bidDepthLots, 0);
        vm.prank(SELLER);
        engine.cancelAll();
        assertEq(IBookDepthEngine(address(engine)).bookDepth().askDepthLots, 0);
    }

    function testDirtyQueueConsumesAll64StepsWithoutCounting65thNode() public {
        _warmIndex();
        for (uint256 orderIndex; orderIndex < 64; ++orderIndex) {
            _placeDepth(BUYER, true, 490, 1, 0);
        }
        vm.prank(BUYER);
        engine.cancelAll();
        _seedDepth();
        IBookDepthEngine.Quote memory quote = IBookDepthEngine(address(engine)).bookDepth();
        assertEq(quote.examined, 64);
        assertEq(quote.bidDepthLots, 0);
        assertEq(quote.askDepthLots, 0);
        assertFalse(_sampleDepth());
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
    }

    function testPendingAccountTopupAndHaltCannotReuseOldCapture() public {
        _warmIndex();
        _seedDepth();
        _sampleDepth();
        token.mint(BUYER, 1);
        vm.startPrank(BUYER);
        token.approve(address(vault), 1);
        vault.deposit(1);
        vault.allocate(address(engine), 1, false);
        vm.stopPrank();
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        oracle.haltEarly();
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        assertEq(IBookDepthEngine(address(engine)).bookDepth().bidDepthLots, 0);
    }

    function testReduceOnlyLiquidityIsExcludedRatherThanDoubleCounted() public {
        _warmIndex();
        _order(SELLER, false, IBookRiskHooks.OrderKind.LIMIT, 500);
        _order(BUYER, true, IBookRiskHooks.OrderKind.IOC, 500);
        _placeDepth(SELLER, true, 490, 500, 0);
        vm.prank(BUYER);
        uint32 reducingAsk =
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, true, 510, 500, 8, 0));
        assertGt(reducingAsk, 0);
        IBookDepthEngine.Quote memory quote = IBookDepthEngine(address(engine)).bookDepth();
        assertEq(quote.bidDepthLots, 500);
        assertEq(quote.askDepthLots, 0);
        assertEq(quote.examined, 2);
    }

    function testIneligibleMakerCannotContributeDisplayedDepth() public {
        DepthEligibilityHarness harness = new DepthEligibilityHarness(vault, TREASURY, configuration);
        engine = harness;
        vault.registerEngine(address(engine));
        _fund(BUYER);
        _fund(SELLER);
        vm.prank(GOVERNOR);
        engine.activateMarket();
        _warmIndex();
        _seedDepth();
        assertEq(IBookDepthEngine(address(engine)).bookDepth().bidDepthLots, 500);
        harness.setCashForTest(BUYER, 0);
        IBookDepthEngine.Quote memory quote = IBookDepthEngine(address(engine)).bookDepth();
        assertEq(quote.bidDepthLots, 0);
        assertEq(quote.askDepthLots, 500);
    }

    function testNormalPricingNeedsAllWindowsAndEpochThenThinBookFallsBack() public {
        vm.warp(1_000_800);
        configuration.listedAt = uint64(block.timestamp);
        configuration.scheduledT = uint64(block.timestamp + 10 days);
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        _fund(BUYER);
        _fund(SELLER);
        vm.prank(GOVERNOR);
        engine.activateMarket();
        _warmIndex();
        _seedDepth();
        _publishDepth();
        uint64 openingAt = configuration.listedAt + 3600;
        while (block.timestamp + 10 < openingAt) {
            vm.warp(block.timestamp + 10);
            _submitNextIndex();
            vm.roll(block.number + 1);
            assertTrue(_sampleDepth());
        }
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available);
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.BOOTSTRAP));
        vm.warp(openingAt);
        _submitNextIndex();
        engine.beginRollover();
        engine.rollPage(32);
        engine.finishRollover();
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.NORMAL_PRICING));
        assertTrue(engine.riskContext().markOk);
        assertFalse(engine.fundingFeatureEnabled());
        assertEq(engine.listing().deploymentCapX, 1);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        assertFalse(engine.riskContext().markOk);
        uint32 freshBid = _placeDepth(BUYER, true, 495, 100, 0);
        assertGt(freshBid, 0);
        vm.prank(BUYER);
        engine.cancel(freshBid);
        assertEq(engine.getOrder(freshBid).size, 0);
    }

    function testPendingFloorInvalidationExcludesOldDepthBeforeFirstBookAction() public {
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        _fund(BUYER);
        _fund(SELLER);
        uint64 floorAt = configuration.scheduledT - 12 hours;
        vm.warp(floorAt - 400);
        vm.prank(GOVERNOR);
        engine.activateMarket();
        _warmIndex();
        _seedDepth();
        assertEq(IBookDepthEngine(address(engine)).bookDepth().bidDepthLots, 500);
        for (uint64 sequence = 32; sequence <= 36; ++sequence) {
            vm.warp(block.timestamp + 20);
            IPriceSource.Observation memory observation = _observation(sequence);
            engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
        }
        assertEq(block.timestamp, floorAt);
        (,, uint64 accountingEnd,,,,) = engine.epoch();
        assertLt(block.timestamp, accountingEnd);
        assertTrue(engine.riskContext().indexOk);
        IBookDepthEngine.Quote memory quote = IBookDepthEngine(address(engine)).bookDepth();
        assertEq(quote.bidDepthLots, 0);
        assertEq(quote.askDepthLots, 0);
        assertEq(quote.examined, 0);
    }

    function testCanonicalIdExistsBeforeFirstBookAction() public view {
        assertEq(engine.participantId(BUYER), 1);
        assertEq(engine.participantId(SELLER), 2);
    }
}
