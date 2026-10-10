// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PricingHarness} from "./B018.t.sol";
import {PricingMath} from "../../../src/math/PricingMath.sol";
import {PricingMode} from "../../../src/math/RiskTypes.sol";
import {RiskPricing, RiskContext} from "../../../src/pricing/RiskPricing.sol";

contract TestnetPricingWindowsTest is Test {
    PricingHarness h;

    function setUp() public {
        vm.chainId(10143);
        h = new PricingHarness(10 days, 0);
    }

    function _assertWindows(uint64 indexSecs, uint64 basisSecs) internal view {
        (uint64 idx, uint64 perp, uint64 basis, uint64 carry) = h.pricingWindows();
        assertEq(idx, indexSecs);
        assertEq(perp, 60);
        assertEq(basis, basisSecs);
        assertEq(carry, 30);
    }

    function _index(uint64 from, uint64 to) internal {
        for (uint64 t = from; t <= to; t += 10) {
            h.index(t, 6e17);
        }
    }

    // Impact mid floor((0.61 + 0.63) / 2) = 0.62; basis against INDEX 0.60 is +0.02.
    function _perp(uint64 from, uint64 to) internal {
        for (uint64 t = from; t <= to; t += 10) {
            h.perp(t, 61e16, 63e16, 600);
        }
    }

    function testFastWindowsAreExclusiveToMonadTestnet() public {
        _assertWindows(60, 60);
        uint256[3] memory otherChains = [uint256(1), 143, 31337];
        for (uint256 i; i < otherChains.length; ++i) {
            vm.chainId(otherChains[i]);
            _assertWindows(300, 900);
        }
    }

    function testIndexRequiresTheEntireSixtySeconds() public {
        _index(1000, 1060);
        PricingMath.Twap memory before = h.indexTwap300(1059);
        assertFalse(before.available);
        assertEq(before.coveredSecs, 59);
        vm.warp(1059);
        assertFalse(h.riskContext().indexOk);
        PricingMath.Twap memory ready = h.indexTwap300(1060);
        assertTrue(ready.available);
        assertEq(ready.coveredSecs, 60);
        assertEq(ready.twapWad, 6e17);
        vm.warp(1060);
        assertTrue(h.riskContext().indexOk);
    }

    /// Book history starts with the first authenticated INDEX point, so all three 60-second
    /// windows complete together and activation needs no epoch opening.
    function testParallelWarmupActivatesWhenAllWindowsComplete() public {
        _index(1000, 1060);
        _perp(1000, 1060);
        vm.warp(1059);
        assertFalse(h.indexTwap300(1059).available);
        assertFalse(h.perpTwap60(1059).available);
        PricingMath.Twap memory basisBefore = h.basisTwap900(1059);
        assertFalse(basisBefore.available);
        assertEq(basisBefore.coveredSecs, 59);
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        h.activate();

        vm.warp(1060);
        PricingMath.Twap memory basis = h.basisTwap900(1060);
        assertTrue(basis.available);
        assertEq(basis.coveredSecs, 60);
        assertEq(basis.twapWad, 2e16);
        assertFalse(h.riskContext().markOk, "complete windows alone are not a mark");
        vm.expectEmit(address(h));
        emit RiskPricing.PricingModeChanged(PricingMode.NORMAL_PRICING, 1060, 1);
        h.activate();
        RiskContext memory c = h.riskContext();
        assertEq(uint8(c.pricingMode), uint8(PricingMode.NORMAL_PRICING));
        assertTrue(c.markOk);
        assertEq(c.markWad, 62e16);
        assertTrue(h.leveraged());
        assertTrue(h.markLiq());
    }

    function testActivationLeavesCalibrationAndRiskVersionToTheEpoch() public {
        _index(1000, 1060);
        _perp(1000, 1060);
        bytes32 initial = h.riskContext().profileHash;
        h.stage(keccak256("profile-2"));
        vm.warp(1060);
        h.activate();
        RiskContext memory c = h.riskContext();
        assertEq(c.riskVersion, 1, "activation does not apply a staged profile");
        assertEq(c.profileHash, initial);
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.NORMAL_PRICING));
        c = h.riskContext();
        assertEq(c.riskVersion, 2, "the completed opening still owns profile activation");
        assertEq(c.profileHash, keccak256("profile-2"));
    }

    function testActivationIsOneTime() public {
        _index(1000, 1060);
        _perp(1000, 1060);
        vm.warp(1060);
        h.activate();
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        h.activate();
    }

    function testActivationRefusesHaltedMarket() public {
        _index(1000, 1060);
        _perp(1000, 1060);
        h.setHalt(1050);
        vm.warp(1060);
        assertTrue(h.basisTwap900(1060).available);
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        h.activate();
        assertEq(uint8(h.riskContext().pricingMode), uint8(PricingMode.BOOTSTRAP));
    }

    function testProductionStillRequiresThreeHundredNineHundredAndEpochOpening() public {
        vm.chainId(143);
        _index(1000, 1900);
        _perp(1000, 1900);
        assertFalse(h.indexTwap300(1299).available);
        assertTrue(h.indexTwap300(1300).available);
        assertFalse(h.basisTwap900(1899).available);
        assertTrue(h.basisTwap900(1900).available);
        vm.warp(1180);
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.BOOTSTRAP));
        vm.warp(1900);
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        h.activate();
        (bool warmup,) = h.warmupIndex();
        assertFalse(warmup);
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.NORMAL_PRICING));
    }

    function testFastIndexDoesNotCarryAcrossThirtyOneSecondGap() public {
        h.index(1000, 6e17);
        h.index(1031, 6e17);
        h.index(1060, 6e17);
        PricingMath.Twap memory index = h.indexTwap300(1060);
        assertFalse(index.available);
        assertEq(index.coveredSecs, 59);
    }

    function testFastBasisGapPreventsActivationAndFreshnessStillExpires() public {
        _index(1000, 1130);
        _perp(1000, 1030);
        _perp(1070, 1130); // The 40-second gap after 1030 carries only 30 seconds.
        vm.warp(1090);
        assertTrue(h.riskContext().indexOk);
        PricingMath.Twap memory basis = h.basisTwap900(1090);
        assertFalse(basis.available);
        assertEq(basis.coveredSecs, 50);
        assertFalse(h.perpTwap60(1090).available);
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        h.activate();
        // A full new 60-second window after the gap is genuine recovery.
        vm.warp(1130);
        assertTrue(h.basisTwap900(1130).available);
        h.activate();
        assertTrue(h.riskContext().markOk);
        vm.warp(1161);
        assertFalse(h.riskContext().indexOk);
        assertFalse(h.perpTwap60(1161).available);
        assertFalse(h.riskContext().markOk, "NORMAL_PRICING never keeps a stale mark");
    }

    function testWarmupPointIsFreshAuthenticatedIndexBeforeTheWindow() public {
        vm.warp(1000);
        (bool available, uint256 point) = h.warmupIndex();
        assertFalse(available, "no observation, no warm-up reference");
        h.index(1000, 6e17);
        vm.warp(1030);
        (available, point) = h.warmupIndex();
        assertTrue(available);
        assertEq(point, 6e17);
        assertFalse(h.riskContext().indexOk);
        vm.warp(1031);
        (available,) = h.warmupIndex();
        assertFalse(available, "the 30-second carry also bounds the warm-up reference");
        h.invalidIndex(1031, 6e17);
        (available,) = h.warmupIndex();
        assertFalse(available, "a depth-invalid observation is not a reference");
    }

    function testWarmupPointEndsWhenIndexWindowCompletesOrMarketHalts() public {
        _index(1000, 1060);
        vm.warp(1059);
        (bool available,) = h.warmupIndex();
        assertTrue(available);
        vm.warp(1060);
        (available,) = h.warmupIndex();
        assertFalse(available, "the INDEX TWAP replaces the warm-up reference");
        h.setHalt(1050);
        vm.warp(1059);
        (available,) = h.warmupIndex();
        assertFalse(available);
    }
}
