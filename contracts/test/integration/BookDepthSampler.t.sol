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

    function indexCheckpointForTest(uint64 observedAt) external view returns (bytes32) {
        return _indexCheckpointAt(observedAt);
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

    function _submitIndexAt(uint64 observedAt, uint256 midWad, bool valid) internal {
        IPriceSource.Observation memory observation =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        observation.observedAt = observedAt;
        observation.priceWad = midWad;
        observation.impactBidWad = midWad - 1e16;
        observation.impactAskWad = midWad + 1e16;
        if (!valid) observation.bidDepthLots = 0;
        engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
    }

    function _captureAfterIndexAge(uint64 age) internal returns (uint64 capturedAt) {
        _warmIndex();
        _seedDepth();
        vm.warp(block.timestamp + age);
        capturedAt = uint64(block.timestamp);
        _sampleDepth();
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

    function _warmContinuousDepth() internal {
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
        _placeDepth(BUYER, true, 490, 1000, 0);
        _placeDepth(SELLER, false, 510, 1000, 0);
        _publishDepth();
        for (uint256 i; i < 90; ++i) {
            vm.warp(block.timestamp + 10);
            _submitNextIndex();
            vm.roll(block.number + 1);
            assertTrue(_sampleDepth());
        }
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available);
    }

    function testRejectedUnsealedCaptureDoesNotEraseSealedPriceHistoryAfterFill() public {
        _warmContinuousDepth();
        uint256 count = engine.ringCount(1);
        vm.warp(block.timestamp + 2);
        vm.prank(BUYER);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 510, 10, 8, 0));
        assertEq(IBookDepthEngine(address(engine)).bookDepth().askDepthLots, 500);
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth(), "changed candidate is never promoted");
        assertEq(engine.ringCount(1), count, "rejected candidate must not overwrite sealed history");
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available, "prior sealed price keeps only its original 30-second carry");
        vm.warp(block.timestamp + 10);
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertTrue(_sampleDepth(), "fresh post-fill depth is separately sealed");
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available);
    }

    function testRejectedCapturesCannotExtendLastAcceptedPriceLifetime() public {
        _warmContinuousDepth();
        // Each mutation rejects the unsealed candidate. None can renew coverage.
        for (uint256 i; i < 4; ++i) {
            vm.warp(block.timestamp + 10);
            _placeDepth(BUYER, true, 480, 1, 0);
            _submitNextIndex();
            vm.roll(block.number + 1);
            assertFalse(_sampleDepth());
        }
        assertTrue(engine.riskContext().indexOk);
        assertFalse(engine.perpTwap60(uint64(block.timestamp)).available);
        assertFalse(engine.basisTwap900(uint64(block.timestamp)).available);
    }

    function testAuditStableThinDepthEndsCarryBeforeThirtySecondExpiry() public {
        _warmContinuousDepth();
        uint256 count = engine.ringCount(1);
        vm.warp(block.timestamp + 1);
        vm.prank(SELLER);
        engine.cancelAll();
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        assertEq(engine.ringCount(1), count, "mutation only discards the pending capture");
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available);

        uint64 thinAt = uint64(block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(thinAt, false);
        assertEq(engine.ringCount(1), count + 1);
        assertFalse(engine.perpTwap60(uint64(block.timestamp)).available);
        assertFalse(engine.basisTwap900(uint64(block.timestamp)).available);
        assertTrue(engine.riskContext().indexOk);
    }

    function testAuditIndexCorrectionStillInvalidatesWhenBookAlsoMutates() public {
        _warmContinuousDepth();
        uint64 capturedAt = uint64(block.timestamp);
        uint256 count = engine.ringCount(1);
        IPriceSource.Observation memory correction =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        correction.priceWad = 501e15;
        correction.impactBidWad = 491e15;
        correction.impactAskWad = 511e15;
        engine.submitObservation(correction, _signature(correction, SIGNER_KEY));
        _placeDepth(BUYER, true, 480, 1, 0);

        vm.warp(block.timestamp + 1);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(capturedAt, false);
        assertEq(engine.ringCount(1), count + 1);
        assertFalse(engine.basisTwap900(uint64(block.timestamp)).available);
        assertTrue(engine.riskContext().indexOk);
    }

    function testEpochRequoteDoesNotEraseSealedPriceHistory() public {
        _warmContinuousDepth();
        uint64 openingAt = configuration.listedAt + 3600;
        while (block.timestamp + 10 < openingAt) {
            vm.warp(block.timestamp + 10);
            _submitNextIndex();
            vm.roll(block.number + 1);
            assertTrue(_sampleDepth());
        }
        vm.warp(openingAt);
        _submitNextIndex();
        engine.beginRollover();
        engine.rollPage(32);
        engine.finishRollover();
        assertTrue(engine.riskContext().markOk);
        _placeDepth(BUYER, true, 490, 1000, 0);
        _placeDepth(SELLER, false, 510, 1000, 0);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth());
        assertTrue(engine.riskContext().markOk);
        vm.warp(block.timestamp + 10);
        _submitNextIndex();
        vm.roll(block.number + 1);
        assertTrue(_sampleDepth());
        assertTrue(engine.riskContext().markOk);
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

    function testSamePriceIndexRefreshPreservesCaptureButStillRequiresStrictlyNewerSeal() public {
        uint64 capturedAt = _captureAfterIndexAge(5);
        vm.warp(capturedAt + 5);
        _submitIndexAt(capturedAt - 1, 5e17, true);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth(), "refresh before capture cannot seal it");
        assertEq(engine.ringCount(1), 0, "economic identity must not manufacture an outage");
        _submitIndexAt(capturedAt, 5e17, true);
        vm.roll(block.number + 1);
        assertFalse(_sampleDepth(), "equal source timestamp still cannot seal");
        assertEq(engine.ringCount(1), 0);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertTrue(_sampleDepth());
        _assertPerpRecord(capturedAt, true);
    }

    function testCompensatedIndexPathWithSameCapturePricingInputsCanPublish() public {
        uint64 capturedAt = _captureAfterIndexAge(10);
        PricingMath.Twap memory beforeWindow = engine.indexTwap300(capturedAt);
        vm.warp(capturedAt + 1);
        _submitIndexAt(capturedAt - 8, 49e16, true);
        _submitIndexAt(capturedAt - 6, 51e16, true);
        _submitIndexAt(capturedAt - 4, 5e17, true);
        PricingMath.Twap memory afterWindow = engine.indexTwap300(capturedAt);
        assertEq(afterWindow.integral, beforeWindow.integral, "two low seconds and two high seconds cancel exactly");
        assertEq(afterWindow.coveredSecs, beforeWindow.coveredSecs);
        assertEq(afterWindow.twapWad, beforeWindow.twapWad);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertTrue(_sampleDepth(), "the invariant is pricing inputs, not every historical segment");
        _assertPerpRecord(capturedAt, true);
    }

    function testNoncompensatedIndexPathRejectsEvenWhenPointAndRoundedTwapMatch() public {
        uint64 capturedAt = _captureAfterIndexAge(10);
        PricingMath.Twap memory beforeWindow = engine.indexTwap300(capturedAt);
        vm.warp(capturedAt + 1);
        _submitIndexAt(capturedAt - 2, 5e17 + 1, true);
        _submitIndexAt(capturedAt - 1, 5e17, true);
        PricingMath.Twap memory afterWindow = engine.indexTwap300(capturedAt);
        assertEq(afterWindow.twapWad, beforeWindow.twapWad, "flooring hides one price-second of correction");
        assertEq(afterWindow.integral, beforeWindow.integral + 1);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth(), "exact integral changes must invalidate");
        _assertPerpRecord(capturedAt, false);
    }

    function testSameTimeIndexPriceCorrectionRejectsDespiteUnchangedWindowIntegral() public {
        uint64 capturedAt = _captureAfterIndexAge(0);
        PricingMath.Twap memory beforeWindow = engine.indexTwap300(capturedAt);
        vm.warp(capturedAt + 1);
        _submitIndexAt(capturedAt, 501e15, true);
        PricingMath.Twap memory afterWindow = engine.indexTwap300(capturedAt);
        assertEq(afterWindow.integral, beforeWindow.integral);
        assertEq(afterWindow.coveredSecs, beforeWindow.coveredSecs);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth(), "instantaneous BASIS input changed at zero elapsed weight");
        _assertPerpRecord(capturedAt, false);
    }

    function testSameTimeIndexValidityCorrectionRejectsDespiteUnchangedWindowIntegral() public {
        uint64 capturedAt = _captureAfterIndexAge(0);
        PricingMath.Twap memory beforeWindow = engine.indexTwap300(capturedAt);
        _submitIndexAt(capturedAt, 5e17, false);
        PricingMath.Twap memory afterWindow = engine.indexTwap300(capturedAt);
        assertEq(afterWindow.integral, beforeWindow.integral);
        assertEq(afterWindow.coveredSecs, beforeWindow.coveredSecs);
        assertTrue(engine.riskContext().indexOk, "zero elapsed invalidity has not changed the current INDEX window");
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(capturedAt, false);
    }

    function testIndexBackfillCreatingCoverageGapRejectsPendingCapture() public {
        uint64 capturedAt = _captureAfterIndexAge(10);
        PricingMath.Twap memory beforeWindow = engine.indexTwap300(capturedAt);
        vm.warp(capturedAt + 1);
        _submitIndexAt(capturedAt - 4, 5e17, false);
        _submitIndexAt(capturedAt - 2, 5e17, true);
        PricingMath.Twap memory afterWindow = engine.indexTwap300(capturedAt);
        assertEq(afterWindow.coveredSecs, beforeWindow.coveredSecs - 2);
        assertFalse(afterWindow.available);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertFalse(_sampleDepth());
        _assertPerpRecord(capturedAt, false);
    }

    function testSamePriceRefreshAtStaleBoundaryDoesNotRefreshPerpCaptureAge() public {
        uint64 capturedAt = _captureAfterIndexAge(30);
        vm.warp(capturedAt + 1);
        _submitIndexAt(capturedAt, 5e17, true);
        _submitNextIndex();
        vm.roll(block.number + 1);
        vm.recordLogs();
        assertTrue(_sampleDepth(), "refresh at the inclusive freshness boundary preserves prior coverage");
        _assertPerpRecord(capturedAt, true);
        assertEq(engine.perpTwap60(capturedAt + 31).coveredSecs, 30, "PERP carry still begins at the original capture");
    }

    function testSamePriceBackfillRepairingStaleGapChangesPricingFingerprint() public {
        DepthEligibilityHarness probe = new DepthEligibilityHarness(vault, TREASURY, configuration);
        engine = probe;
        uint64 first = uint64(block.timestamp);
        _submitIndexAt(first, 5e17, true);
        vm.warp(first + 40);
        uint64 capturedAt = uint64(block.timestamp);
        bytes32 beforeFingerprint = probe.indexCheckpointForTest(capturedAt);
        assertEq(engine.indexTwap300(capturedAt).coveredSecs, 30);
        _submitIndexAt(first + 20, 5e17, true);
        assertEq(engine.indexTwap300(capturedAt).coveredSecs, 40);
        assertNotEq(probe.indexCheckpointForTest(capturedAt), beforeFingerprint,
            "same price cannot hide a change in historical coverage");
    }

    function testWindowStartCumulativeIsCommittedEvenWhenEndAndPointAreIdentical() public {
        DepthEligibilityHarness probe = new DepthEligibilityHarness(vault, TREASURY, configuration);
        engine = probe;
        uint64 first = uint64(block.timestamp);
        _submitIndexAt(first, 5e17, true);
        vm.warp(first + 10);
        _submitIndexAt(first + 10, 5e17, true);
        vm.warp(first + 330);
        uint64 capturedAt = uint64(block.timestamp);
        bytes32 beforeFingerprint = probe.indexCheckpointForTest(capturedAt);
        PricingMath.Twap memory beforeWindow = engine.indexTwap300(capturedAt);
        // Total integral from first to capture remains20e18 and coverage40.
        // The start at first+30 changes by +2e18, so the300s window must differ.
        _submitIndexAt(first + 10, 6e17, true);
        _submitIndexAt(first + 30, 3e17, true);
        _submitIndexAt(first + 40, 5e17, false);
        PricingMath.Twap memory afterWindow = engine.indexTwap300(capturedAt);
        assertEq(afterWindow.coveredSecs, beforeWindow.coveredSecs);
        assertEq(afterWindow.integral, beforeWindow.integral - 2e18);
        assertFalse(beforeWindow.available);
        assertFalse(afterWindow.available);
        assertNotEq(probe.indexCheckpointForTest(capturedAt), beforeFingerprint,
            "matching the cumulative endpoint and unavailable point is insufficient");
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

    function testAuditLateBootstrapRolloverUsesExistingCarryToOpenNormal() public {
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
        uint64 boundary = configuration.listedAt + 3600;
        uint64 firstCapture = boundary - 891;
        while (block.timestamp + 10 < firstCapture) {
            vm.warp(block.timestamp + 10);
            _submitNextIndex();
        }
        vm.warp(firstCapture);
        _submitNextIndex();
        _seedDepth();
        _publishDepth();
        while (block.timestamp + 10 < boundary) {
            vm.warp(block.timestamp + 10);
            _submitNextIndex();
            vm.roll(block.number + 1);
            assertTrue(_sampleDepth());
        }
        vm.warp(boundary);
        _submitNextIndex();
        assertEq(uint8(engine.work()), 0, "storage work has not begun rollover");
        assertEq(uint8(engine.marketRiskView().accountingState), 1, "expired epoch blocks sampling");
        assertEq(IBookDepthEngine(address(engine)).bookDepth().bidDepthLots, 0);
        assertFalse(engine.basisTwap900(boundary).available);
        assertTrue(engine.perpTwap60(boundary + 17).available, "accepted carry covers opening plus reserve");
        assertFalse(engine.perpTwap60(boundary + 20).available, "delay cannot extend accepted carry");

        vm.warp(boundary + 9);
        _submitNextIndex();
        assertTrue(engine.basisTwap900(uint64(block.timestamp)).available);
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.BOOTSTRAP));
        engine.beginRollover();
        engine.rollPage(32);
        engine.finishRollover();
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.NORMAL_PRICING));
        assertTrue(engine.riskContext().markOk);
        (, uint64 openedAt, uint64 endsAt,,,,) = engine.epoch();
        assertEq(openedAt, boundary + 9, "opening uses actual time");
        assertEq(endsAt, boundary + 3600, "opening retains the next hourly boundary");
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
