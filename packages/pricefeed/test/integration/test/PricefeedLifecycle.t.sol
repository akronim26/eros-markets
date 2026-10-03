// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {InvalidEngine} from "risk-test/risk/B/B035.t.sol";
import {ListingFixture} from "risk-test/risk/B/B019.t.sol";
import {RiskFixture} from "risk-test/math/B/B011.t.sol";
import {MockResolutionAuthority} from "risk-test/mocks/B/MockResolutionAuthority.sol";
import {IMarketConfig} from "risk/interfaces/IMarketConfig.sol";
import {IPriceSource} from "risk/interfaces/IPriceSource.sol";
import {PricingMath} from "risk/math/PricingMath.sol";
import {LifecycleMath} from "risk/math/LifecycleMath.sol";
import {Stage} from "risk/math/RiskTypes.sol";

/// Existing risk implementation and scripted counterparts are imported read-only.
contract LifecycleHarness is InvalidEngine {
    function recordedWindow() external view returns (PricingMath.Twap memory) {
        return _invalidWindowTwap();
    }
}

/// Accelerated deterministic fixtures, NOT a 24-hour live-source soak.
/// The test actor operates the mock oracle; the feed path calls submitObservation only.
contract PricefeedLifecycleTest is Test {
    uint256 constant KEY = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint64 constant L0 = 1_000_000;
    uint64 constant T = L0 + 10 days;
    uint64 constant EARLY_HALT = T - 2 days;
    LifecycleHarness private engine;
    IMarketConfig.Listing private listing;
    uint64 private sequence;

    function build(bool fallbackListed) private {
        vm.chainId(31337);
        vm.warp(L0);
        MockResolutionAuthority oracle = new MockResolutionAuthority();
        engine = new LifecycleHarness();
        listing = ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), vm.addr(KEY));
        listing.scheduledT = T;
        if (!fallbackListed) listing.invalidRule = IMarketConfig.InvalidRule(false, 0, 0, 30 days);
        engine.init(listing, RiskFixture.profile(5, true));
        oracle.bind(engine);
        vm.warp(EARLY_HALT);
        oracle.haltEarly();
        oracle.finalize(3);
        sequence = 0;
    }

    function sample(uint64 t, bool valid) private {
        vm.warp(t);
        // Independently specified two equal 43,200-second regions: .42 then .62.
        uint256 p = t < T - 43_200 ? 42e16 : 62e16;
        IPriceSource.Observation memory o = IPriceSource.Observation({
            marketId: listing.marketId, sourceId: listing.indexSourceId, sequence: ++sequence,
            observedAt: t, publishedAt: t, priceWad: valid ? p : 0,
            impactBidWad: valid ? p - 1e16 : 0, impactAskWad: valid ? p + 1e16 : 0,
            bidDepthLots: valid ? 500 : 0, askDepthLots: valid ? 500 : 0,
            sourceRulesHash: listing.indexRulesHash
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, engine.observationDigest(o));
        engine.submitObservation(o, abi.encodePacked(r, s, v));
    }

    function history(bool missing, bool thin) private {
        for (uint64 t = T - 86_400; t <= T; t += 20) {
            // 100-second inter-sample gap leaves 70 seconds uncovered after 30-second carry.
            if (missing && t > T - 50_000 && t < T - 49_900) continue;
            sample(t, !(thin && t == T - 40));
        }
    }

    function assertStillHalted() private view {
        assertEq(uint8(engine.riskContext().stage), uint8(Stage.HALTED));
        assertEq(uint8(engine.riskContext().admission), uint8(LifecycleMath.Admission.NONE));
        assertLe(engine.fundingCutoffNow(), EARLY_HALT);
        assertEq(engine.mockFreezeCount(), 1);
        assertEq(uint8(engine.finalOutcome()), 3, "only the fixture oracle chose INVALID");
    }

    function test_signedFull24HourHistoryAfterEarlyHaltCapturesExactTwapOnce() public {
        build(true);
        (, bool premature) = engine.captureInvalidPrice();
        assertFalse(premature);
        history(false, false);
        PricingMath.Twap memory tw = engine.recordedWindow();
        assertTrue(tw.available);
        assertEq(tw.coveredSecs, 86_400);
        // (.42 * 43200 + .62 * 43200) / 86400 = .52, distinct from .5 fallback.
        assertEq(tw.twapWad, 52e16);
        assertEq(tw.integral, int256(uint256(52e16) * 86_400));
        assertEq(sequence, 4321);
        assertEq(engine.ringCount(0), 1024, "24-hour record survives live-ring wrap");
        (LifecycleMath.InvalidReadiness status, bool captured) = engine.captureInvalidPrice();
        assertTrue(captured);
        assertEq(uint8(status), uint8(LifecycleMath.InvalidReadiness.CAPTURE_TWAP));
        (, uint256 price, uint8 reason, bytes32 provenance,) = engine.invalidPrice();
        assertEq(price, 52e16);
        assertEq(reason, engine.REASON_TWAP());
        sample(T + 20, true);
        engine.captureInvalidPrice();
        (, uint256 afterPrice,, bytes32 afterProvenance,) = engine.invalidPrice();
        assertEq(afterPrice, price);
        assertEq(afterProvenance, provenance);
        assertStillHalted();
    }

    function test_missingHistoryIsUnavailableAndOnlyEngineAppliesListedFallbackAfterGrace() public {
        build(true);
        history(true, false);
        assertEq(sequence, 4317);
        PricingMath.Twap memory tw = engine.recordedWindow();
        assertFalse(tw.available);
        assertEq(tw.coveredSecs, 86_330);
        (LifecycleMath.InvalidReadiness status, bool captured) = engine.captureInvalidPrice();
        assertFalse(captured);
        assertEq(uint8(status), uint8(LifecycleMath.InvalidReadiness.WAIT_GRACE));
        vm.warp(T + 3599);
        (, captured) = engine.captureInvalidPrice();
        assertFalse(captured);
        vm.warp(T + 3600);
        (, captured) = engine.captureInvalidPrice();
        assertTrue(captured);
        (, uint256 price, uint8 reason,,) = engine.invalidPrice();
        assertEq(price, 5e17);
        assertEq(reason, engine.REASON_FALLBACK_MISSING_INDEX());
        assertEq(engine.sourceState(listing.indexSourceId).lastSequence, 4317, "fallback creates no feed packet");
        assertStillHalted();
    }

    function test_legacyMissingHistoryNeverAcquiresUnlistedFallback() public {
        build(false);
        history(true, false);
        vm.warp(T + 10 days);
        (LifecycleMath.InvalidReadiness status, bool captured) = engine.captureInvalidPrice();
        assertFalse(captured);
        assertEq(uint8(status), uint8(LifecycleMath.InvalidReadiness.BLOCKED));
        assertStillHalted();
    }

    function test_authenticatedThinCheckpointAddsNoCoverageOrOracleOutcome() public {
        build(true);
        history(false, true);
        PricingMath.Twap memory tw = engine.recordedWindow();
        assertFalse(tw.available);
        assertEq(tw.coveredSecs, 86_380);
        assertEq(sequence, 4321);
        (, bool captured) = engine.captureInvalidPrice();
        assertFalse(captured);
        assertStillHalted();
    }
}
