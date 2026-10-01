// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {InvalidPrice} from "../../../src/settlement/InvalidPrice.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {RiskContextPort} from "../../../src/risk/RiskContextPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {AdmissionMode, FinalOutcome, Stage} from "../../../provisional/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract InvalidEngine is InvalidPrice, MockBookAdapter, MockAccountingPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function index(uint64 t, uint256 p) external {
        _onIndexObservation(t, p, true);
    }

    function fundingCutoffNow() external view returns (uint64) {
        return _riskFundingCutoff(type(uint64).max, 0, 0);
    }

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function getSettlementStatus() external view returns (SettlementView memory v) {}
}

/// B035: deterministic INVALID capture with exact boundaries.
contract B035Test is Test {
    uint64 constant L0 = 1_000_000;
    uint64 T;
    InvalidEngine e;
    MockResolutionAuthority oracle;

    function build(bool fallbackListed) internal {
        vm.warp(L0);
        oracle = new MockResolutionAuthority();
        e = new InvalidEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 10 days;
        if (!fallbackListed) l.invalidRule = IMarketConfig.InvalidRule(false, 0, 0, 30 days);
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        oracle.bind(e);
    }

    function feedWindow(uint256 p, uint64 gapFrom, uint64 gapTo) internal {
        for (uint64 t = T - 86_400 - 20; t <= T + 300; t += 20) {
            if (t > gapFrom && t < gapTo) continue;
            e.index(t, p);
        }
    }

    function test_earlyInvalidWaitsForT() public {
        build(true);
        vm.warp(T - 5 days);
        oracle.haltEarly();
        oracle.finalize(3); // INVALID accepted now
        assertEq(uint8(e.finalOutcome()), uint8(FinalOutcome.INVALID));
        (LifecycleMath.InvalidReadiness s, bool captured) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.NOT_YET));
        assertFalse(captured);
        (bool ready,,,,) = e.invalidPrice();
        assertFalse(ready, "price pending, never a halt-time replacement");
    }

    function test_completeWindowCapturedOnceAtT() public {
        build(true);
        feedWindow(42e16, 0, 0);
        vm.warp(T - 1);
        (, bool captured) = e.captureInvalidPrice();
        assertFalse(captured, "T - 1 cannot capture");
        vm.warp(T);
        (LifecycleMath.InvalidReadiness s, bool c2) = e.captureInvalidPrice();
        assertTrue(c2);
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.CAPTURE_TWAP));
        (bool ready, uint256 p, uint8 reason,,) = e.invalidPrice();
        assertTrue(ready);
        assertEq(p, 42e16);
        assertEq(reason, e.REASON_TWAP());
        // later observations cannot revise
        e.index(T + 400, 9e17);
        e.captureInvalidPrice();
        (, uint256 p2,,,) = e.invalidPrice();
        assertEq(p2, 42e16);
    }

    function test_incompleteNewListingFallbackAfterGrace() public {
        build(true);
        feedWindow(42e16, T - 50_000, T - 49_900); // 100 s gap: no carry across a 30 s stale gap
        vm.warp(T);
        (LifecycleMath.InvalidReadiness s, bool c) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.WAIT_GRACE));
        assertFalse(c);
        vm.warp(T + 3599);
        (s, c) = e.captureInvalidPrice();
        assertFalse(c);
        vm.warp(T + 3600);
        (s, c) = e.captureInvalidPrice();
        assertTrue(c);
        (, uint256 p, uint8 reason,,) = e.invalidPrice();
        assertEq(p, 5e17);
        assertEq(reason, e.REASON_FALLBACK_MISSING_INDEX());
    }

    function test_legacyListingBlockedNeverFallback() public {
        build(false);
        feedWindow(42e16, T - 50_000, T - 49_900);
        vm.warp(T + 10 days);
        (LifecycleMath.InvalidReadiness s, bool c) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.BLOCKED));
        assertFalse(c);
    }

    function test_postHaltSamplesDoNotResumeRisk() public {
        build(true);
        vm.warp(T - 5 days);
        oracle.haltEarly();
        uint64 cutoffAtHalt = e.fundingCutoffNow();
        for (uint64 t = T - 5 days + 10; t <= T - 5 days + 1000; t += 10) {
            e.index(t, 6e17);
        }
        vm.warp(T - 5 days + 1000);
        RiskContext memory c = e.riskContext();
        assertEq(uint8(c.stage), uint8(Stage.HALTED));
        assertEq(uint8(c.admission), uint8(LifecycleMath.Admission.NONE));
        assertLe(e.fundingCutoffNow(), T - 5 days, "funding never runs past the halt");
        assertLe(cutoffAtHalt, T - 5 days);
    }

    function test_listingHorizonBoundary() public {
        vm.warp(L0);
        InvalidEngine x = new InvalidEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(0xAC), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 30 days - 3599; // T + 1h > listedAt + 30d
        vm.expectRevert(abi.encodeWithSelector(RiskContextPort.BadListing.selector, uint8(2)));
        x.init(l, RiskFixture.profile(5, true));
        l.scheduledT = L0 + 30 days - 3600;
        x.init(l, RiskFixture.profile(5, true));
    }
}
