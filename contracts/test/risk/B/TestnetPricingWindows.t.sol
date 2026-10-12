// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PricingHarness} from "./B018.t.sol";
import {PricingMath} from "../../../src/math/PricingMath.sol";
import {PricingMode} from "../../../src/math/RiskTypes.sol";
import {RiskPricing, RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {StoreHarness} from "./B017.t.sol";
import {GuardHarness} from "./B021.t.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract TestnetPricingWindowsTest is Test {
    PricingHarness h;

    function setUp() public {
        vm.chainId(10143);
        h = new PricingHarness(10 days, 0);
    }

    function _assertWindows(uint64 indexSecs, uint64 basisSecs, uint64 indexCarrySecs) internal view {
        (uint64 idx, uint64 perp, uint64 basis, uint64 carry) = h.pricingWindows();
        assertEq(idx, indexSecs);
        assertEq(perp, 60);
        assertEq(basis, basisSecs);
        assertEq(carry, indexCarrySecs);
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
        _assertWindows(60, 60, 120);
        uint256[3] memory otherChains = [uint256(1), 143, 31337];
        for (uint256 i; i < otherChains.length; ++i) {
            vm.chainId(otherChains[i]);
            _assertWindows(300, 900, 30);
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

    /// The testnet publisher sends about every 80 s; each INDEX sample carries 120 s, so the
    /// 60-second window stays covered between observations and lapses exactly 120 s after the last.
    function testTestnetIndexCarryBridgesEightySecondCadence() public {
        for (uint64 t = 1000; t <= 1400; t += 80) {
            h.index(t, 6e17);
        }
        for (uint64 t = 1060; t <= 1520; t += 20) {
            assertTrue(h.indexTwap300(t).available);
        }
        vm.warp(1520);
        assertTrue(h.riskContext().indexOk);
        PricingMath.Twap memory lapsed = h.indexTwap300(1521);
        assertFalse(lapsed.available);
        assertEq(lapsed.coveredSecs, 59); // [1461, 1520] from the 1400 carry
        vm.warp(1521);
        assertFalse(h.riskContext().indexOk);
    }

    function testFastIndexDoesNotCarryAcrossGapBeyondIndexCarry() public {
        h.index(1000, 6e17);
        h.index(1121, 6e17);
        h.index(1180, 6e17);
        PricingMath.Twap memory index = h.indexTwap300(1180);
        assertFalse(index.available);
        assertEq(index.coveredSecs, 59); // [1120, 1121) is uncovered
        h.index(1300, 6e17);
        assertTrue(h.indexTwap300(1300).available, "a gap of exactly 120 s is still covered");
    }

    function testOtherChainsKeepThirtySecondIndexCarry() public {
        vm.chainId(143);
        for (uint64 t = 1000; t <= 1300; t += 30) {
            h.index(t, 6e17);
        }
        h.index(1331, 6e17);
        PricingMath.Twap memory index = h.indexTwap300(1360);
        assertFalse(index.available);
        assertEq(index.coveredSecs, 299); // 300-second window; [1330, 1331) is uncovered
    }

    function testBookGapBeyondBookCarryPreventsActivationAndIndexStillExpires() public {
        _index(1000, 1600);
        _perp(1000, 1030);
        _perp(1340, 1600); // The 310-second gap after 1030 carries only the 300-second book carry.
        vm.warp(1380);
        assertTrue(h.riskContext().indexOk);
        PricingMath.Twap memory basis = h.basisTwap900(1380);
        assertFalse(basis.available);
        assertEq(basis.coveredSecs, 50); // [1320, 1330) from the 1030 carry plus [1340, 1380)
        vm.expectRevert(RiskPricing.PricingActivationUnavailable.selector);
        h.activate();
        // A full new 60-second window after the gap is genuine recovery.
        vm.warp(1400);
        assertTrue(h.basisTwap900(1400).available);
        h.activate();
        assertTrue(h.riskContext().markOk);
        // INDEX carries 120 s: a source stopped after 1600 removes the mark at 1721.
        vm.warp(1720);
        assertTrue(h.riskContext().markOk);
        vm.warp(1721);
        assertFalse(h.riskContext().indexOk);
        assertTrue(h.perpTwap60(1721).available, "book samples carry 300 s");
        assertFalse(h.riskContext().markOk, "NORMAL_PRICING never keeps a mark without a fresh INDEX");
    }

    /// A capture is sealed only by a later INDEX observation, so consecutive sealed book samples
    /// can be two publish cycles apart. On Monad testnet a 290-second gap stays covered.
    function testTestnetBookCarryBridgesASlowSeal() public {
        _index(1000, 1400);
        _perp(1000, 1030);
        _perp(1320, 1400);
        vm.warp(1350);
        PricingMath.Twap memory perp = h.perpTwap60(1350);
        assertTrue(perp.available);
        assertEq(perp.coveredSecs, 60);
        assertTrue(h.basisTwap900(1350).available);
    }

    function testOtherChainsKeepThirtySecondBookCarry() public {
        vm.chainId(143);
        _index(1000, 1400);
        _perp(1000, 1330);
        _perp(1370, 1400); // 40-second gap: only 30 seconds carry off Monad testnet.
        vm.warp(1400);
        assertFalse(h.perpTwap60(1400).available);
        assertEq(h.perpTwap60(1400).coveredSecs, 50);
    }

    function testWarmupPointIsFreshAuthenticatedIndexBeforeTheWindow() public {
        vm.warp(1000);
        (bool available, uint256 point) = h.warmupIndex();
        assertFalse(available, "no observation, no warm-up reference");
        h.index(1000, 6e17);
        vm.warp(1059);
        (available, point) = h.warmupIndex();
        assertTrue(available);
        assertEq(point, 6e17);
        assertFalse(h.riskContext().indexOk);
        // One observation carries 120 s, so it covers the 60-second window from 1060 to 1120.
        vm.warp(1060);
        (available,) = h.warmupIndex();
        assertFalse(available, "the INDEX TWAP replaces the warm-up reference");
        assertTrue(h.riskContext().indexOk);
        vm.warp(1121);
        (available,) = h.warmupIndex();
        assertFalse(h.riskContext().indexOk);
        assertFalse(available, "the 120-second INDEX carry also bounds the warm-up reference");
        h.invalidIndex(1121, 6e17);
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

/// The INVALID-window integral and funding freshness use the same INDEX carry as the live
/// series, so an 80-second testnet cadence is contiguous coverage everywhere.
contract TestnetIndexCarryConsumersTest is Test {
    uint64 constant T = 1_000_000;

    function setUp() public {
        vm.chainId(10143);
    }

    /// Window start falls 50 s after the latest pre-window sample; one early publish lands 10 s
    /// before T. With the old 30 s endpoint carry the start lost 20 s that the end did not, so
    /// coverage read 86,420 s and the INVALID price was unavailable.
    function testInvalidWindowIsContiguousAtEightySecondCadence() public {
        StoreHarness st = new StoreHarness(T);
        uint64 start = T - 86400;
        for (uint64 t = start - 3650; t <= T + 600; t += 80) {
            if (t > T - 10 && t - 80 < T - 10) st.index(T - 10, 5e17, true);
            st.index(t, 5e17, true);
        }
        PricingMath.Twap memory tw = st.invalidTwap();
        assertTrue(tw.available);
        assertEq(tw.coveredSecs, 86400);
        assertEq(tw.twapWad, 5e17);
    }

    function testInvalidWindowGapBeyondIndexCarryIsIncomplete() public {
        StoreHarness st = new StoreHarness(T);
        uint64 start = T - 86400;
        for (uint64 t = start - 3650; t <= T + 600; t += 80) {
            if (t > start + 1000 && t < start + 1100) continue; // one 160 s gap
            st.index(t, 5e17, true);
        }
        assertFalse(st.invalidTwap().available);
    }

    function testFundingFreshnessFollowsIndexCarry() public {
        uint64 l0 = 1_000_000;
        vm.warp(l0);
        GuardHarness g = new GuardHarness();
        g.init(
            ListingFixture.make(l0, address(0x0AC1E), address(0x3031), address(0x6007), address(0x516)),
            RiskFixture.profile(5, true)
        );
        g.index(l0 + 10, 6e17, true);
        assertTrue(g.freshAt(l0 + 130));
        assertFalse(g.freshAt(l0 + 131));
        vm.warp(l0 + 10);
        g.openEpoch();
        for (uint64 t = l0 + 90; t <= l0 + 3610; t += 80) {
            g.index(t, 6e17, true);
        }
        (uint64 freshThrough, uint64 stop,) = g.freshness();
        assertEq(stop, 0, "an 80-second cadence opens no funding gap");
        assertEq(freshThrough, l0 + 3610 + 120);
        g.index(l0 + 3851, 6e17, true); // 121 s after coverage lapsed at l0 + 3730
        (, stop,) = g.freshness();
        assertEq(stop, l0 + 3730);
    }
}
