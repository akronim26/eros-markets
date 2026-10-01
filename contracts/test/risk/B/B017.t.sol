// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ObservationStore} from "../../../src/pricing/ObservationStore.sol";
import {PricingMath as PM} from "../../../src/math/PricingMath.sol";

contract StoreHarness is ObservationStore {
    constructor(uint64 scheduledT) {
        _initIngress(keccak256("m"), keccak256("idx"), DepthRule(500, 5e16));
        _initStore(scheduledT);
    }

    function index(uint64 t, uint256 p, bool valid) external {
        _onIndexObservation(t, p, valid);
    }

    function perp(uint64 t, uint256 bid, uint256 ask, uint256 depth) external {
        _recordPerp(t, bid, ask, depth, depth);
    }

    function invalidTwap() external view returns (PM.Twap memory) {
        return _invalidWindowTwap();
    }

    function valueAt(uint8 s, uint64 t) external view returns (bool, int256) {
        return _valueAt(s, t);
    }
}

/// B017: valid-window observation storage. Expected values follow B007 reference semantics
/// (time integral over carried intervals, 30 s carry, same-second replacement).
contract B017Test is Test {
    uint64 constant T = 1_000_000;
    StoreHarness st;

    function setUp() public {
        st = new StoreHarness(T);
    }

    function test_index300IrregularTimeWeighted() public {
        // 0.40 for 200 s (samples every 20 s), then 0.70 for 100 s (samples at irregular spacing)
        for (uint64 t = 1000; t < 1200; t += 20) {
            st.index(t, 4e17, true);
        }
        uint64[5] memory ts = [uint64(1200), 1229, 1230, 1255, 1280];
        for (uint256 i; i < 5; ++i) {
            st.index(ts[i], 7e17, true);
        }
        PM.Twap memory tw = st.indexTwap300(1300);
        assertTrue(tw.available);
        assertEq(tw.twapWad, (4e17 * 200 + 7e17 * 100) / 300);
    }

    function test_staleGapInvalidates() public {
        for (uint64 t = 1000; t <= 1300; t += 30) {
            if (t == 1150) continue; // 60 s gap between 1120 and 1180
            st.index(t, 5e17, true);
        }
        PM.Twap memory tw = st.indexTwap300(1300);
        assertFalse(tw.available);
        assertEq(tw.coveredSecs, 270);
    }

    function test_sameSecondReplacement() public {
        st.index(1000, 4e17, true);
        st.index(1000, 6e17, true);
        for (uint64 t = 1030; t <= 1300; t += 30) {
            st.index(t, 6e17, true);
        }
        assertEq(st.ringCount(0), 11); // 1000 (replaced in place) + 1030..1300
        assertEq(st.indexTwap300(1300).twapWad, 6e17);
    }

    function test_perpAndBasisWindows() public {
        for (uint64 t = 0; t <= 1000; t += 10) {
            st.index(t, 60e16, true);
            st.perp(t, 61e16, 63e16, 600); // mid 0.62
        }
        PM.Twap memory p60 = st.perpTwap60(1000);
        assertTrue(p60.available);
        assertEq(p60.twapWad, 62e16);
        PM.Twap memory b900 = st.basisTwap900(1000);
        assertTrue(b900.available);
        assertEq(b900.twapWad, 2e16);
        (bool ok, int256 live) = st.valueAt(1, 1000);
        assertTrue(ok);
        assertEq(live, 62e16);
    }

    function test_basisInvalidWhenIndexStale() public {
        st.index(0, 60e16, true);
        st.perp(100, 61e16, 63e16, 600);
        (bool ok,) = st.valueAt(2, 100);
        assertFalse(ok, "basis sample invalid: index stale at perp time");
    }

    function test_thinPerpDepthInvalid() public {
        for (uint64 t = 0; t <= 100; t += 10) {
            st.perp(t, 61e16, 63e16, 499);
        }
        assertFalse(st.perpTwap60(100).available);
    }

    function test_nonMonotoneRejected() public {
        st.index(1000, 5e17, true);
        vm.expectRevert(ObservationStore.NonMonotoneSample.selector);
        st.index(999, 5e17, true);
    }

    function test_ringWrapKeepsLiveWindows() public {
        for (uint64 t = 0; t < 3000; t += 1) {
            st.index(t, t % 2 == 0 ? 4e17 : 6e17, true);
        }
        assertEq(st.ringCount(0), 1024);
        PM.Twap memory tw = st.indexTwap300(2999);
        assertTrue(tw.available);
        assertEq(tw.twapWad, 5e17);
        // a window older than retained history is unavailable, never guessed
        assertFalse(st.indexTwap300(1000).available);
    }

    function test_invalidHistoryNotPrunedByRing() public {
        uint64 start = T - 86400;
        // 25 hours of 20 s samples: > 1024 ring entries, window [T-24h, T] fully covered
        for (uint64 t = start - 3600; t <= T + 600; t += 20) {
            st.index(t, t < start + 43200 ? 4e17 : 6e17, true);
        }
        PM.Twap memory tw = st.invalidTwap();
        assertTrue(tw.available);
        assertEq(tw.twapWad, 5e17);
        (uint64 s, uint64 e, bool hs, bool he) = st.invalidWindow();
        assertEq(s, start);
        assertEq(e, T);
        assertTrue(hs && he);
    }

    function test_invalidWindowGapIncomplete() public {
        uint64 start = T - 86400;
        for (uint64 t = start; t <= T; t += 20) {
            if (t > start + 1000 && t < start + 1100) continue;
            st.index(t, 5e17, true);
        }
        assertFalse(st.invalidTwap().available);
    }

    function test_postTSamplesDoNotChangeInvalidCapture() public {
        uint64 start = T - 86400;
        for (uint64 t = start; t <= T; t += 20) {
            st.index(t, 5e17, true);
        }
        PM.Twap memory before = st.invalidTwap();
        st.index(T + 5, 9e17, true);
        st.index(T + 100, 9e17, true);
        PM.Twap memory afterT = st.invalidTwap();
        assertEq(before.twapWad, afterT.twapWad);
        assertEq(before.integral, afterT.integral);
    }
}
