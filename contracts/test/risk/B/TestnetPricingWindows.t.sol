// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PricingHarness} from "./B018.t.sol";
import {PricingMath} from "../../../src/math/PricingMath.sol";
import {PricingMode} from "../../../src/math/RiskTypes.sol";

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
        for (uint64 t = from; t <= to; t += 10) h.index(t, 6e17);
    }

    function _perp(uint64 from, uint64 to) internal {
        for (uint64 t = from; t <= to; t += 10) h.perp(t, 61e16, 63e16, 600);
    }

    function testFastWindowsAreExclusiveToMonadTestnet() public {
        _assertWindows(60, 180);
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

    function testSequentialWarmupNeedsFullBasisAndEpochOpening() public {
        _index(1000, 1240);
        // Model usable depth beginning only after INDEX has its first complete 60 seconds.
        _perp(1060, 1240);
        vm.warp(1239);
        PricingMath.Twap memory before = h.basisTwap900(1239);
        assertFalse(before.available);
        assertEq(before.coveredSecs, 179);
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.BOOTSTRAP));
        vm.warp(1240);
        PricingMath.Twap memory ready = h.basisTwap900(1240);
        assertTrue(ready.available);
        assertEq(ready.coveredSecs, 180);
        assertEq(ready.twapWad, 2e16);
        assertTrue(h.perpTwap60(1240).available);
        assertFalse(h.riskContext().markOk, "complete windows do not bypass epoch promotion");
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.NORMAL_PRICING));
        assertTrue(h.riskContext().markOk);
        assertEq(h.riskContext().markWad, 62e16);
    }

    function testProductionStillRequiresThreeHundredAndNineHundredSeconds() public {
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

    function testFastBasisGapPreventsPromotionAndFreshnessStillExpires() public {
        _index(1000, 1240);
        _perp(1060, 1110);
        _perp(1150, 1240); // 40-second gap carries only 30 seconds.
        vm.warp(1240);
        assertTrue(h.riskContext().indexOk);
        assertTrue(h.perpTwap60(1240).available);
        PricingMath.Twap memory basis = h.basisTwap900(1240);
        assertFalse(basis.available);
        assertEq(basis.coveredSecs, 170);
        assertEq(uint8(h.openEpoch()), uint8(PricingMode.BOOTSTRAP));
        vm.warp(1271);
        assertFalse(h.riskContext().indexOk);
        assertFalse(h.perpTwap60(1271).available);
    }
}
